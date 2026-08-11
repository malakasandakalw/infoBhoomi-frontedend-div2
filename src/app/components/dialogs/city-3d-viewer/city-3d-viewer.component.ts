import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Inject,
  Optional,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import earcut from 'earcut';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { APIsService } from '../../../services/api.service';
import { NotificationService } from '../../../services/notifications.service';
import { DrawService, SelectedFeatureInfo } from '../../../services/draw.service';
import { SidebarControlService } from '../../../services/sidebar-control.service';
import { UnitCompositionComponent } from '../unit-composition/unit-composition.component';
import { qa, qaErr } from '../../../core/qa-log';

const WGS84_A = 6378137.0;

interface CityBuilding {
  su_id: number;
  name: string | null;
  cityjson_id: number | null;
  centroid: [number, number] | null;
  loaded: boolean;
}

interface SearchHit {
  su_id: number;
  building_su_id: number;
  kind: string;
  label: string | null;
  centroid: [number, number] | null;
}

/** Dialog data. When `parcelSuId` is set the viewer runs in parcel-focused
 *  mode: only that parcel's buildings load and the parcel fabric is shown. */
export interface City3dViewerData {
  parcelSuId?: number;
  parcelLabel?: string;
}

/**
 * Whole-city 3D viewer. Loads every imported building within the login user's
 * administrative area (server-filtered) and renders them in ONE three.js scene,
 * each placed at its real-world offset (anchor in metadata.georeferencing).
 * A search box flies the camera to a matched building/unit.
 */
@Component({
  selector: 'app-city-3d-viewer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatDialogModule, MatProgressSpinnerModule],
  templateUrl: './city-3d-viewer.component.html',
  styleUrl: './city-3d-viewer.component.css',
})
export class City3dViewerComponent implements AfterViewInit, OnDestroy {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly api = inject(APIsService);
  private readonly notify = inject(NotificationService);
  private readonly drawService = inject(DrawService);
  private readonly sidebarService = inject(SidebarControlService);
  private readonly dialog = inject(MatDialog);

  // picking
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  /** mesh.userData.kind/su_id/layerId set on every pickable mesh. */
  selectedSuId: number | null = null;
  /** building su_id -> its THREE.Group (for select highlight). */
  private buildingGroups = new Map<number, THREE.Group>();
  /** The building su_id currently selected (enables the Units/Compose button). */
  selectedBuildingSuId: number | null = null;
  selectedBuildingName: string | null = null;

  @ViewChild('sceneContainer', { static: true })
  sceneContainer!: ElementRef<HTMLDivElement>;

  buildings: CityBuilding[] = [];
  searchTerm = '';
  searchResults: SearchHit[] = [];
  loading = true;
  statusMsg = 'Loading city…';
  emptyArea = false;

  // three.js
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private animationId: number | null = null;

  // scene georeferencing origin (lon/lat of the first building)
  private originLon = 0;
  private originLat = 0;
  private mPerDegLat = (Math.PI * WGS84_A) / 180;
  private mPerDegLon = this.mPerDegLat;

  // su_id -> world position (scene-centred) for fly-to
  private buildingWorldPos = new Map<number, THREE.Vector3>();
  private sceneCenter = new THREE.Vector3();

  // parcel-focused mode
  parcelSuId: number | null = null;
  title = 'City 3D View';

  constructor(
    public dialogRef: MatDialogRef<City3dViewerComponent>,
    @Optional() @Inject(MAT_DIALOG_DATA) public data: City3dViewerData | null,
  ) {
    if (data?.parcelSuId != null) {
      this.parcelSuId = data.parcelSuId;
      this.title = data.parcelLabel ? `3D View — ${data.parcelLabel}` : 'Parcel 3D View';
    }
    qa('CityViewer', 'open', {
      parcelSuId: this.parcelSuId,
      mode: this.parcelSuId ? 'parcel' : 'city',
    });
  }

  ngAfterViewInit(): void {
    try {
      this.initScene();
      qa('CityViewer', 'scene-init ok', {
        canvas: !!this.renderer,
        size: [
          this.sceneContainer.nativeElement.clientWidth,
          this.sceneContainer.nativeElement.clientHeight,
        ],
        webgl: !!this.renderer?.getContext(),
      });
    } catch (e) {
      qaErr('CityViewer', 'scene-init FAILED', e);
    }
    this.loadCity();
  }

  ngOnDestroy(): void {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    this.renderer?.domElement.removeEventListener('click', this.onPick);
    this.renderer?.dispose();
  }

  close(): void {
    this.dialogRef.close();
  }

  // parcel fabric (reused from PostGIS), parcel-focused mode only
  private parcelGeoJson: any = null;
  private parcelCentroid: [number, number] | null = null;

  // ---------------------------------------------------------------- loading
  private loadCity(): void {
    qa('CityViewer', 'admin-area request', { parcelSuId: this.parcelSuId });
    this.api.listAdminArea3DBuildings(this.parcelSuId ?? undefined).subscribe({
      next: (res) => {
        const parcels = res?.parcels ?? [];
        qa('CityViewer', 'admin-area response', {
          buildings: res?.buildings?.length ?? 0,
          parcels: parcels.length,
          parcelsCapped: !!res?.parcels_capped,
          focusParcel: res?.parcel?.su_id ?? null,
        });
        this.parcelGeoJson = res?.parcel?.geojson ?? null;
        this.parcelCentroid = res?.parcel?.centroid ?? null;
        const list = res?.buildings ?? [];

        // scene origin: focus-parcel centroid (right-click) > any parcel > first building
        const originSrc =
          this.parcelCentroid ??
          this.firstParcelCentroid(parcels) ??
          list.find((b: any) => b.centroid)?.centroid ??
          null;
        if (originSrc) {
          this.originLon = originSrc[0];
          this.originLat = originSrc[1];
          this.mPerDegLon = this.mPerDegLat * Math.cos((this.originLat * Math.PI) / 180);
        }

        if (list.length === 0 && parcels.length === 0) {
          this.loading = false;
          this.emptyArea = true;
          this.statusMsg = 'Nothing to show in your area yet.';
          this.cdr.markForCheck();
          return;
        }

        this.buildings = list.map((b: any) => ({
          su_id: b.su_id,
          name: b.name,
          cityjson_id: b.cityjson_id,
          centroid: b.centroid,
          loaded: false,
        }));

        // full city fabric: OSM ground + all parcels first (under the buildings)
        this.drawAllParcels(parcels);
        this.drawOsmGround();

        if (this.buildings.length === 0) {
          this.loading = false;
          this.statusMsg = 'Parcels shown — no 3D buildings imported yet.';
          this.frameScene();
          this.cdr.markForCheck();
          return;
        }
        this.fetchAllModels();
      },
      error: (err) => {
        this.loading = false;
        this.statusMsg = 'Failed to load 3D view.';
        qaErr('CityViewer', 'admin-area request FAILED', err);
        this.notify.showError(err?.error?.error || 'Failed to load 3D view.');
        this.cdr.markForCheck();
      },
    });
  }

  /** Convert a lon/lat to scene-local ENU metres around the origin. */
  private lonLatToScene(lon: number, lat: number): [number, number] {
    return [(lon - this.originLon) * this.mPerDegLon, (lat - this.originLat) * this.mPerDegLat];
  }

  /** Rough centroid (lon/lat) of the first parcel's outer ring, for scene origin. */
  private firstParcelCentroid(
    parcels: Array<{ su_id: number; geojson: any }>,
  ): [number, number] | null {
    for (const p of parcels) {
      const rings = this.extractPolygonRings(p.geojson);
      if (rings.length && rings[0].length) {
        let sx = 0,
          sy = 0;
        for (const [lon, lat] of rings[0]) {
          sx += lon;
          sy += lat;
        }
        return [sx / rings[0].length, sy / rings[0].length];
      }
    }
    return null;
  }

  /**
   * Draw the reused parcel polygon as a flat ground slab at z=0, textured with
   * an OSM raster tile covering the parcel extent. This is cadastral context
   * reused from PostGIS — NOT an IFC-derived shell.
   */
  // scene-wide ground bounds (metres), accumulated across all parcels
  private groundMinX = Infinity;
  private groundMinY = Infinity;
  private groundMaxX = -Infinity;
  private groundMaxY = -Infinity;

  /**
   * Draw ONE land parcel as an outline + thin translucent slab, tagged with its
   * own su_id so a click selects that parcel (land layer 1). Accumulates the
   * scene-wide ground bbox for the shared OSM plane.
   */
  private drawOneParcel(geojson: any, suId: number | null): void {
    const rings = this.extractPolygonRings(geojson);
    if (!rings.length) return;

    const group = new THREE.Group();
    for (const ring of rings) {
      const pts = ring.map(([lon, lat]) => {
        const [x, y] = this.lonLatToScene(lon, lat);
        this.groundMinX = Math.min(this.groundMinX, x);
        this.groundMinY = Math.min(this.groundMinY, y);
        this.groundMaxX = Math.max(this.groundMaxX, x);
        this.groundMaxY = Math.max(this.groundMaxY, y);
        return new THREE.Vector2(x, y);
      });
      const outline = new THREE.BufferGeometry().setFromPoints(
        pts.map((p) => new THREE.Vector3(p.x, p.y, 0.06)),
      );
      group.add(new THREE.Line(outline, new THREE.LineBasicMaterial({ color: 0x1565c0 })));
    }

    try {
      const shape = new THREE.Shape(
        rings[0].map(([lon, lat]) => {
          const [x, y] = this.lonLatToScene(lon, lat);
          return new THREE.Vector2(x, y);
        }),
      );
      const slab = new THREE.ShapeGeometry(shape);
      const mat = new THREE.MeshStandardMaterial({
        color: suId === this.parcelSuId ? 0xdfeaff : 0xf2f4f7,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(slab, mat);
      mesh.position.z = 0.04; // just above the OSM plane
      if (suId != null) mesh.userData = { kind: 'parcel', su_id: suId, layerId: 1 };
      group.add(mesh);
    } catch {
      /* degenerate ring — outline already added */
    }

    this.scene.add(group);
  }

  /** Draw every parcel in the area (full city fabric). */
  private drawAllParcels(parcels: Array<{ su_id: number; geojson: any }>): void {
    qa('CityViewer', 'draw parcels', { count: parcels.length });
    for (const p of parcels) this.drawOneParcel(p.geojson, p.su_id);
  }

  /**
   * One OSM raster plane spanning the whole accumulated ground bbox, sitting
   * under every parcel + building. Falls back to a plain plane if tiles are
   * blocked (CORS/policy).
   */
  private drawOsmGround(): void {
    if (!isFinite(this.groundMinX)) return; // no parcels drawn
    // pad the bbox a little so context extends beyond the parcels
    const padX = (this.groundMaxX - this.groundMinX) * 0.15 + 20;
    const padY = (this.groundMaxY - this.groundMinY) * 0.15 + 20;
    const minX = this.groundMinX - padX,
      maxX = this.groundMaxX + padX;
    const minY = this.groundMinY - padY,
      maxY = this.groundMaxY + padY;
    const w = maxX - minX,
      h = maxY - minY;
    if (w <= 0 || h <= 0) return;

    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xe8edf2,
      side: THREE.DoubleSide,
    });
    const plane = new THREE.Mesh(geo, mat);
    // sit the OSM basemap well below the parcel slabs (z=0.04) so the two
    // coplanar rasters don't z-fight / flicker against the parcel fabric.
    plane.position.set((minX + maxX) / 2, (minY + maxY) / 2, -0.6);
    this.scene.add(plane);
    this.loadOsmTexture(minX, minY, maxX, maxY, mat);
    qa('CityViewer', 'osm ground plane', { w: Math.round(w), h: Math.round(h) });
  }

  /** Pull [[lon,lat],...] outer/inner rings from a GeoJSON Polygon/MultiPolygon. */
  private extractPolygonRings(g: any): number[][][] {
    if (!g) return [];
    if (g.type === 'Polygon') return g.coordinates;
    if (g.type === 'MultiPolygon') return g.coordinates.flat();
    return [];
  }

  /**
   * Fetch a single OSM tile covering the parcel bbox and apply it as the slab
   * texture, UV-mapped so the parcel sits correctly on the map imagery.
   */
  private loadOsmTexture(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    mat: THREE.MeshStandardMaterial,
  ): void {
    // bbox back to lon/lat
    const lon1 = this.originLon + minX / this.mPerDegLon;
    const lon2 = this.originLon + maxX / this.mPerDegLon;
    const lat1 = this.originLat + minY / this.mPerDegLat;
    const lat2 = this.originLat + maxY / this.mPerDegLat;
    const west = Math.min(lon1, lon2),
      east = Math.max(lon1, lon2);
    const south = Math.min(lat1, lat2),
      north = Math.max(lat1, lat2);

    const lon2tileX = (lon: number, z: number) => ((lon + 180) / 360) * Math.pow(2, z);
    const lat2tileY = (lat: number, z: number) => {
      const r = (lat * Math.PI) / 180;
      return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
    };

    // pick the highest zoom whose tile span fits in a small grid (<= ~6x6 tiles)
    let z = 19;
    for (; z >= 1; z--) {
      const txSpan = Math.floor(lon2tileX(east, z)) - Math.floor(lon2tileX(west, z)) + 1;
      const tySpan = Math.floor(lat2tileY(south, z)) - Math.floor(lat2tileY(north, z)) + 1;
      if (txSpan <= 6 && tySpan <= 6) break;
    }
    const x0 = Math.floor(lon2tileX(west, z));
    const x1 = Math.floor(lon2tileX(east, z));
    const y0 = Math.floor(lat2tileY(north, z)); // north = smaller tile Y
    const y1 = Math.floor(lat2tileY(south, z));
    const cols = x1 - x0 + 1,
      rows = y1 - y0 + 1;
    const TS = 256;

    const canvas = document.createElement('canvas');
    canvas.width = cols * TS;
    canvas.height = rows * TS;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e8edf2';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    qa('CityViewer', 'osm-mosaic', { z, cols, rows, tiles: cols * rows });

    let loaded = 0;
    const total = cols * rows;
    const applyWhenDone = () => {
      // crop the mosaic to the exact bbox so it lines up with the slab
      const mosaicWestX = x0,
        mosaicNorthY = y0;
      const u0 = lon2tileX(west, z) - mosaicWestX;
      const u1 = lon2tileX(east, z) - mosaicWestX;
      const v0 = lat2tileY(north, z) - mosaicNorthY;
      const v1 = lat2tileY(south, z) - mosaicNorthY;
      const crop = document.createElement('canvas');
      crop.width = Math.max(1, Math.round((u1 - u0) * TS));
      crop.height = Math.max(1, Math.round((v1 - v0) * TS));
      crop
        .getContext('2d')!
        .drawImage(
          canvas,
          u0 * TS,
          v0 * TS,
          (u1 - u0) * TS,
          (v1 - v0) * TS,
          0,
          0,
          crop.width,
          crop.height,
        );
      const tex = new THREE.CanvasTexture(crop);
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
      mat.needsUpdate = true;
      qa('CityViewer', 'osm ground applied', { z, cols, rows });
      this.cdr.markForCheck();
    };

    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          ctx.drawImage(img, (tx - x0) * TS, (ty - y0) * TS, TS, TS);
          if (++loaded === total) applyWhenDone();
        };
        img.onerror = () => {
          if (++loaded === total) applyWhenDone();
          qaErr('CityViewer', 'osm tile failed', `${z}/${tx}/${ty}`);
        };
        img.src = `https://tile.openstreetmap.org/${z}/${tx}/${ty}.png`;
      }
    }
  }

  private fetchAllModels(): void {
    this.statusMsg = `Loading ${this.buildings.length} building(s)…`;
    this.cdr.markForCheck();

    const calls = this.buildings.map((b) =>
      this.api.load3DData(b.su_id).pipe(
        map((res) => ({ b, cityjson: this.extractCityJson(res) })),
        catchError(() => of({ b, cityjson: null })),
      ),
    );

    forkJoin(calls).subscribe((results) => {
      let drawn = 0;
      for (const { b, cityjson } of results) {
        const objCount = cityjson?.CityObjects ? Object.keys(cityjson.CityObjects).length : 0;
        const vtxCount = cityjson?.vertices?.length ?? 0;
        if (cityjson && this.drawBuilding(b, cityjson)) {
          b.loaded = true;
          drawn++;
          qa('CityViewer', 'building drawn', {
            su_id: b.su_id,
            objects: objCount,
            vertices: vtxCount,
          });
        } else {
          qaErr('CityViewer', 'building NOT drawn (no cityjson or no meshes)', {
            su_id: b.su_id,
            hasCityjson: !!cityjson,
            objects: objCount,
            vertices: vtxCount,
          });
        }
      }
      this.loading = false;
      this.statusMsg = drawn > 0 ? `${drawn} building(s) loaded.` : 'No renderable buildings.';
      qa('CityViewer', 'load complete', { requested: this.buildings.length, drawn });
      // right-click mode: zoom to the focus parcel's building(s); else frame whole city
      const focusBuilding =
        this.parcelSuId != null
          ? this.buildings.find((b) => this.buildingWorldPos.has(b.su_id))
          : undefined;
      const focusPos = focusBuilding ? this.buildingWorldPos.get(focusBuilding.su_id) : undefined;
      if (focusPos) {
        this.frameScene(); // set sensible far/near first
        this.flyTo(focusPos);
      } else {
        this.frameScene();
      }
      this.cdr.markForCheck();
    });
  }

  private extractCityJson(res: any): any {
    if (!res) return null;
    if (res.CityObjects) return res;
    const rows = Array.isArray(res) ? res : Array.isArray(res?.results) ? res.results : null;
    if (rows && rows.length > 0) return rows[0]?.cityjson_data ?? rows[0] ?? null;
    if (res.cityjson_data) return res.cityjson_data;
    return null;
  }

  // ---------------------------------------------------------------- three.js
  private initScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xeaf2f8);

    const el = this.sceneContainer.nativeElement;
    const width = el.clientWidth || 900;
    const height = el.clientHeight || 600;

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 10_000_000);
    this.camera.up.set(0, 0, 1);

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    el.appendChild(canvas);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(120, 120, 200);
    this.scene.add(dir);

    // (no grid helper — the OSM basemap provides ground context)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.maxPolarAngle = Math.PI;

    this.renderer.domElement.addEventListener('click', this.onPick);
    this.animate();
  }

  /**
   * Click → raycast for a tagged mesh (parcel / building) → push the same
   * SelectedFeatureInfo the 2D map emits into DrawService, so the docked side
   * panel populates IDENTICALLY to a 2D click (same fetch/merge/save path).
   */
  private onPick = (event: MouseEvent): void => {
    if (!this.renderer || !this.scene) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    const hit = hits.find((h) => (h.object as THREE.Mesh).userData?.['su_id'] != null);
    if (!hit) {
      qa('CityViewer', 'pick: no tagged mesh under cursor', { totalHits: hits.length });
      return;
    }

    const ud = (hit.object as THREE.Mesh).userData as {
      kind: string;
      su_id: number;
      layerId: number;
      roomId?: string | null;
    };
    qa('CityViewer', 'pick', ud);

    // In the MAIN 3D view we always select at the BUILDING level (layer 3),
    // never individual apartments — clicking any part of a building (room mesh
    // or shell) selects the whole building and highlights it. Apartment/unit-
    // level selection happens only inside the Unit Composition window.
    // A parcel-ground click (layer 1) selects the parcel.
    if (ud.layerId === 1) {
      this.clearBuildingHighlight();
      this.selectBySuId(ud.su_id, 1);
    } else {
      this.highlightBuilding(ud.su_id);
      this.selectBySuId(ud.su_id, 3);
    }
  };

  // ---- building highlight (selected building glows) -----------------------
  private highlightedBuildingSuId: number | null = null;

  private highlightBuilding(suId: number): void {
    if (this.highlightedBuildingSuId === suId) return;
    this.clearBuildingHighlight();
    const group = this.buildingGroups.get(suId);
    if (!group) return;
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if ((m as any).isMesh) {
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.emissive?.setHex(0x2962ff);
        if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.45;
        mat.needsUpdate = true;
      }
    });
    this.highlightedBuildingSuId = suId;
  }

  private clearBuildingHighlight(): void {
    if (this.highlightedBuildingSuId == null) return;
    const group = this.buildingGroups.get(this.highlightedBuildingSuId);
    group?.traverse((o) => {
      const m = o as THREE.Mesh;
      if ((m as any).isMesh) {
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.emissive?.setHex(0x000000);
        if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0;
        mat.needsUpdate = true;
      }
    });
    this.highlightedBuildingSuId = null;
  }

  /** Push selection into the shared stream + open the side panel. */
  private selectBySuId(suId: number, layerId: number): void {
    qa('CityViewer', 'select -> side panel', { suId, layerId });
    this.selectedSuId = suId;
    // building pick → enable Units button; parcel pick → clear it.
    // (unit/layer-12 picks leave the building context as set by the room-pick.)
    if (layerId === 3) {
      this.selectedBuildingSuId = suId;
      this.selectedBuildingName = this.buildings.find((b) => b.su_id === suId)?.name ?? null;
    } else if (layerId === 1) {
      this.selectedBuildingSuId = null;
      this.selectedBuildingName = null;
    }
    const info: SelectedFeatureInfo = { featureId: suId, layerId };
    // ensure the docked side panel is visible, then feed it the selection
    this.sidebarService.setSidebarState(false);
    this.drawService._selectedFeatureInfo.next([info]);
    // confirmation so the user knows the click registered (panel is on the left,
    // behind/beside this right-docked viewer)
    const what = layerId === 12 ? 'Apartment/Unit' : layerId === 3 ? 'Building' : 'Parcel';
    this.notify.showInfo(`${what} ${suId} selected — see the side panel (left).`);
    this.cdr.markForCheck();
  }

  /**
   * Open the Unit Composition window for the selected building (B3b) — the
   * separate window where the surveyor picks rooms (with two-way highlight)
   * and groups them into apartments / common spaces. On a successful compose,
   * refresh that building's geometry so the new LSBU is reflected.
   */
  openUnitComposition(): void {
    if (this.selectedBuildingSuId == null) return;
    qa('CityViewer', 'open Unit Composition', { buildingSuId: this.selectedBuildingSuId });
    const ref = this.dialog.open(UnitCompositionComponent, {
      width: '96vw',
      maxWidth: '1500px',
      height: '90vh',
      panelClass: 'unit-composition-dialog',
      data: { buildingSuId: this.selectedBuildingSuId, buildingName: this.selectedBuildingName },
    });
    ref.afterClosed().subscribe((changed) => {
      if (changed) {
        this.notify.showSuccess('Composition saved.');
        // re-fetch this building's model so the merged LSBU shows
        const b = this.buildings.find((x) => x.su_id === this.selectedBuildingSuId);
        if (b) {
          this.api.load3DData(b.su_id).subscribe((res) => {
            const cj = this.extractCityJson(res);
            if (cj) this.drawBuilding(b, cj);
            this.cdr.markForCheck();
          });
        }
      }
    });
  }

  /** Returns true if at least one mesh was added for this building. */
  private drawBuilding(b: CityBuilding, cityjson: any): boolean {
    if (!cityjson?.CityObjects || !cityjson?.vertices) return false;

    // building world offset from scene origin (metres), from its anchor
    const anchor = cityjson?.metadata?.georeferencing;
    let offEast = 0;
    let offNorth = 0;
    if (anchor && typeof anchor.anchor_lon === 'number') {
      offEast = (anchor.anchor_lon - this.originLon) * this.mPerDegLon;
      offNorth = (anchor.anchor_lat - this.originLat) * this.mPerDegLat;
    } else if (b.centroid) {
      offEast = (b.centroid[0] - this.originLon) * this.mPerDegLon;
      offNorth = (b.centroid[1] - this.originLat) * this.mPerDegLat;
    }

    const transform = cityjson.transform;
    const verts: number[][] = (cityjson.vertices as number[][]).map((v) => {
      const x = transform ? v[0] * transform.scale[0] + transform.translate[0] : v[0];
      const y = transform ? v[1] * transform.scale[1] + transform.translate[1] : v[1];
      const z = transform ? v[2] * transform.scale[2] + transform.translate[2] : v[2];
      return [x + offEast, y + offNorth, z];
    });

    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xb8c6d8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
    });

    let meshes = 0;
    Object.entries<any>(cityjson.CityObjects).forEach(([roomId, obj]: [string, any]) => {
      if (!obj.geometry) return;
      const isBuilding = obj.type === 'Building';
      obj.geometry.forEach((geom: any) => {
        this.traverseBoundaries(geom.boundaries, (ring) => {
          const g = this.ringToGeometry(ring, verts);
          if (g) {
            const mesh = new THREE.Mesh(g, mat.clone());
            // Tag for picking. In the main 3D view every mesh (building shell or
            // room) selects the whole building (layer 3); apartment/unit-level
            // selection only happens inside the Unit Composition window.
            mesh.userData = {
              kind: isBuilding ? 'building' : 'room',
              su_id: b.su_id,
              layerId: 3,
              roomId: isBuilding ? null : roomId,
            };
            group.add(mesh);
            meshes++;
          }
        });
      });
    });

    if (meshes === 0) return false;

    // if this building was already drawn (e.g. after recompose), remove the old group
    const prev = this.buildingGroups.get(b.su_id);
    if (prev) this.scene.remove(prev);

    this.scene.add(group);
    this.buildingGroups.set(b.su_id, group);

    // record building centre (avg of its vertices) for fly-to
    const box = new THREE.Box3().setFromObject(group);
    const centre = box.getCenter(new THREE.Vector3());
    this.buildingWorldPos.set(b.su_id, centre);
    return true;
  }

  private ringToGeometry(indices: number[], vertices: number[][]): THREE.BufferGeometry | null {
    if (!Array.isArray(indices) || indices.length < 3) return null;
    const pts3d = indices.map((i) => vertices[i]).filter(Boolean);
    if (pts3d.length < 3) return null;

    const n = this.getNormal(pts3d);
    let a1 = 0;
    let a2 = 1;
    if (Math.abs(n[2]) >= Math.abs(n[0]) && Math.abs(n[2]) >= Math.abs(n[1])) {
      a1 = 0;
      a2 = 1;
    } else if (Math.abs(n[0]) >= Math.abs(n[1])) {
      a1 = 1;
      a2 = 2;
    } else {
      a1 = 0;
      a2 = 2;
    }
    const flat2d = pts3d.map((p) => [p[a1], p[a2]]).flat();
    const tris = earcut(flat2d);
    if (!tris.length) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts3d.flat(), 3));
    geom.setIndex(tris);
    geom.computeVertexNormals();
    return geom;
  }

  private traverseBoundaries(boundary: any, cb: (ring: number[]) => void): void {
    if (!boundary) return;
    if (Array.isArray(boundary[0])) {
      boundary.forEach((b: any) => this.traverseBoundaries(b, cb));
    } else if (typeof boundary[0] === 'number') {
      cb(boundary);
    }
  }

  private getNormal(points: number[][]): number[] {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < points.length; i++) {
      const c = points[i];
      const npt = points[(i + 1) % points.length];
      nx += (c[1] - npt[1]) * (c[2] + npt[2]);
      ny += (c[2] - npt[2]) * (c[0] + npt[0]);
      nz += (c[0] - npt[0]) * (c[1] + npt[1]);
    }
    return [nx, ny, nz];
  }

  private frameScene(): void {
    const box = new THREE.Box3().setFromObject(this.scene);
    if (box.isEmpty()) return;
    this.sceneCenter = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 10);
    const d = maxDim * 1.6;
    this.camera.position.set(
      this.sceneCenter.x - d,
      this.sceneCenter.y - d,
      this.sceneCenter.z + d,
    );
    this.camera.lookAt(this.sceneCenter);
    this.controls.target.copy(this.sceneCenter);
    this.controls.maxDistance = maxDim * 12;
    this.controls.update();
  }

  private flyTo(pos: THREE.Vector3): void {
    const d = 60;
    this.camera.position.set(pos.x - d, pos.y - d, pos.z + d);
    this.controls.target.copy(pos);
    this.controls.update();
  }

  private animate = (): void => {
    if (this.renderer && this.scene && this.camera) {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.animationId = requestAnimationFrame(this.animate);
    }
  };

  // ---------------------------------------------------------------- UI
  selectBuilding(su_id: number): void {
    const pos = this.buildingWorldPos.get(su_id);
    if (pos) this.flyTo(pos);
    // selecting from the list also drives the side panel + enables Units button
    this.selectBySuId(su_id, 3);
  }

  runSearch(): void {
    const q = this.searchTerm.trim();
    if (!q) {
      this.searchResults = [];
      this.cdr.markForCheck();
      return;
    }
    this.api.search3DObjects(q).subscribe({
      next: (res) => {
        this.searchResults = res?.results ?? [];
        this.cdr.markForCheck();
      },
      error: () => {
        this.searchResults = [];
        this.cdr.markForCheck();
      },
    });
  }

  goToHit(hit: SearchHit): void {
    // fly to the parent building's loaded mesh; if not loaded, ignore
    const pos = this.buildingWorldPos.get(hit.building_su_id);
    if (pos) {
      this.flyTo(pos);
    } else {
      this.notify.showInfo('That building is not loaded in the current view.');
    }
  }
}

import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Inject,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import earcut from 'earcut';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { APIsService } from '../../../services/api.service';
import { NotificationService } from '../../../services/notifications.service';
import { qa, qaErr } from '../../../core/qa-log';

export interface UnitCompositionData {
  /** survey_rep.id of the building whose rooms are being composed. */
  buildingSuId: number;
  /** Optional building label for the header. */
  buildingName?: string;
}

interface PoolUnit {
  su_id: number;
  apt_name: string | null;
  floor_no: number | null;
  floor_area: number | null;
  building_unit_type: string | null;
  cadastral_id: string | null;
  /** CityJSON room object ids this unit represents (usually one). */
  component_units: string[];
  selected: boolean;
  /** primary room object id used as the 3D handle / highlight key. */
  roomId: string;
}

/** An existing Legal Space Building Unit (apartment / common space). */
interface ApartmentItem {
  su_id: number;
  apt_name: string | null;
  building_unit_type: string | null;
  cadastral_id: string | null;
  /** member room object ids already folded into this apartment. */
  rooms: string[];
}

const PRIVATE_TYPES = ['RESIDENTIAL', 'COMMERCIAL'];
const COMMON_TYPES = ['CIRCULATION', 'SERVICE', 'PARKING', 'AMENITY'];

/**
 * Unit Composition window — manage Legal Space Building Units for a 3D building.
 *
 * Supports the "create the apartment first, assign 3D units later" workflow:
 *   1. create an apartment manually (label / type / cadastral ID) with NO rooms;
 *   2. it appears in the apartments list (and the side panel after refresh);
 *   3. select it, then pick one or more unassigned rooms (3D or list) and assign
 *      them — rooms highlight in the model so the surveyor can confirm;
 *   4. edit the apartment's metadata anytime.
 */
@Component({
  selector: 'app-unit-composition',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatDialogModule, MatProgressSpinnerModule],
  templateUrl: './unit-composition.component.html',
  styleUrl: './unit-composition.component.css',
})
export class UnitCompositionComponent implements AfterViewInit, OnDestroy {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly api = inject(APIsService);
  private readonly notify = inject(NotificationService);

  @ViewChild('sceneContainer', { static: true })
  sceneContainer!: ElementRef<HTMLDivElement>;

  pool: PoolUnit[] = [];
  apartments: ApartmentItem[] = [];
  selectedApartment: ApartmentItem | null = null;

  loading = true;
  statusMsg = 'Loading building…';
  saving = false;
  /** true once any change is persisted, so the caller refreshes on close. */
  private dirty = false;

  // create-apartment form
  readonly privateTypes = PRIVATE_TYPES;
  readonly commonTypes = COMMON_TYPES;
  showCreate = false;
  newType = 'RESIDENTIAL';
  newCadastral = '';
  newName = '';

  // edit-apartment form (bound when an apartment is selected)
  editType = 'RESIDENTIAL';
  editCadastral = '';
  editName = '';

  // three.js
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private animationId: number | null = null;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  // roomId -> meshes; mesh -> roomId
  private roomMeshes = new Map<string, THREE.Mesh[]>();
  private meshRoom = new Map<THREE.Mesh, string>();
  private buildingGroup!: THREE.Group;

  private readonly COLOR_DEFAULT = 0xb8c6d8;
  private readonly COLOR_SELECTED = 0xffc107; // pool room picked for assignment
  private readonly COLOR_MEMBER = 0x4caf50; // already belongs to selected apartment
  private readonly COLOR_HOVER = 0x2196f3;

  constructor(
    public dialogRef: MatDialogRef<UnitCompositionComponent, boolean>,
    @Inject(MAT_DIALOG_DATA) public data: UnitCompositionData,
  ) {}

  ngAfterViewInit(): void {
    this.initScene();
    this.loadData();
  }

  ngOnDestroy(): void {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    this.renderer?.dispose();
    this.renderer?.domElement.removeEventListener('click', this.onCanvasClick);
  }

  // ---------------------------------------------------------------- derived
  get isNewPrivate(): boolean {
    return PRIVATE_TYPES.includes(this.newType);
  }

  get isEditPrivate(): boolean {
    return PRIVATE_TYPES.includes(this.editType);
  }

  get selectedCount(): number {
    return this.pool.filter((u) => u.selected).length;
  }

  /** Pool grouped by floor — easier to compose per-floor apartments. */
  get floorGroups(): Array<{ floor: number | null; label: string; units: PoolUnit[] }> {
    const map = new Map<number | null, PoolUnit[]>();
    for (const u of this.pool) {
      const f = u.floor_no ?? null;
      if (!map.has(f)) map.set(f, []);
      map.get(f)!.push(u);
    }
    const groups = Array.from(map.entries()).map(([floor, units]) => ({
      floor,
      label: floor === null ? 'Unknown floor' : `Floor ${floor}`,
      units,
    }));
    groups.sort((a, b) => {
      if (a.floor === null) return 1;
      if (b.floor === null) return -1;
      return a.floor - b.floor;
    });
    return groups;
  }

  apartmentLabel(a: ApartmentItem): string {
    return a.apt_name || a.cadastral_id || `Unit ${a.su_id}`;
  }

  // ---------------------------------------------------------------- data
  private loadData(reselectSuId?: number): void {
    qa('UnitComp', 'load', { buildingSuId: this.data.buildingSuId });
    forkJoin({
      units: this.api.listBuildingUnits(this.data.buildingSuId).pipe(
        catchError((e) => {
          qaErr('UnitComp', 'listBuildingUnits FAILED', e?.error ?? e);
          return of(null);
        }),
      ),
      cj: this.api.load3DData(this.data.buildingSuId).pipe(
        map((res) => this.extractCityJson(res)),
        catchError((e) => {
          qaErr('UnitComp', 'load3DData FAILED', e?.error ?? e);
          return of(null);
        }),
      ),
    }).subscribe(({ units, cj }) => {
      if (!units) {
        this.loading = false;
        this.statusMsg = 'Failed to load building units.';
        this.notify.showError('Failed to load building units.');
        this.cdr.markForCheck();
        return;
      }
      this.pool = (units.pool ?? []).map((u: any) => ({
        ...u,
        selected: false,
        roomId: (u.component_units && u.component_units[0]) ?? String(u.su_id),
      }));
      this.apartments = (units.lsbus ?? []).map((a: any) => ({
        su_id: a.su_id,
        apt_name: a.apt_name,
        building_unit_type: a.building_unit_type,
        cadastral_id: a.cadastral_id,
        rooms: Array.isArray(a.component_units) ? a.component_units : [],
      }));

      // (re)draw rooms only once — the geometry doesn't change between reloads
      if (cj && this.roomMeshes.size === 0) this.drawRooms(cj);

      // restore / clear selection
      if (reselectSuId != null) {
        const found = this.apartments.find((a) => a.su_id === reselectSuId) ?? null;
        this.selectApartment(found, false);
      } else if (this.selectedApartment) {
        const still =
          this.apartments.find((a) => a.su_id === this.selectedApartment!.su_id) ?? null;
        this.selectApartment(still, false);
      } else {
        this.repaintAll();
      }

      qa('UnitComp', 'loaded', {
        poolUnits: this.pool.length,
        apartments: this.apartments.length,
        roomMeshKeys: this.roomMeshes.size,
      });
      this.loading = false;
      this.statusMsg = `${this.apartments.length} apartment(s) · ${this.pool.length} unassigned room(s).`;
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

  // ---------------------------------------------------------------- apartments
  startCreate(): void {
    this.showCreate = true;
    this.newType = 'RESIDENTIAL';
    this.newCadastral = '';
    this.newName = '';
    this.cdr.markForCheck();
  }

  cancelCreate(): void {
    this.showCreate = false;
    this.cdr.markForCheck();
  }

  createApartment(): void {
    if (this.isNewPrivate && !this.newCadastral.trim()) {
      this.notify.showWarning('A cadastral ID is required for a private apartment.');
      return;
    }
    this.saving = true;
    this.cdr.markForCheck();

    const payload = {
      buildingSuId: this.data.buildingSuId,
      buildingUnitType: this.newType,
      aptName: this.newName.trim() || undefined,
      cadastralId: this.isNewPrivate ? this.newCadastral.trim() : undefined,
    };
    qa('UnitComp', 'create apartment', payload);

    this.api.createApartment(payload).subscribe({
      next: (res) => {
        this.saving = false;
        this.dirty = true;
        this.showCreate = false;
        this.notify.showSuccess(`${this.newType} apartment created.`);
        const newId = res?.su_id;
        qa('UnitComp', 'create OK', res);
        this.loadData(newId); // reload and select the new apartment
      },
      error: (err) => {
        this.saving = false;
        qaErr('UnitComp', `create FAILED (HTTP ${err?.status})`, err?.error ?? err);
        this.notify.showError(
          err?.error?.error || err?.error?.detail || 'Could not create apartment.',
        );
        this.cdr.markForCheck();
      },
    });
  }

  selectApartment(apt: ApartmentItem | null, clearPool = true): void {
    this.selectedApartment = apt;
    if (apt) {
      this.editType = apt.building_unit_type || 'RESIDENTIAL';
      this.editCadastral = apt.cadastral_id || '';
      this.editName = apt.apt_name || '';
    }
    if (clearPool) this.pool.forEach((u) => (u.selected = false));
    this.repaintAll();
    this.cdr.markForCheck();
    qa('UnitComp', 'select apartment', {
      su_id: apt?.su_id ?? null,
      rooms: apt?.rooms?.length ?? 0,
    });
  }

  saveApartmentMeta(): void {
    const apt = this.selectedApartment;
    if (!apt) return;
    if (this.isEditPrivate && !this.editCadastral.trim()) {
      this.notify.showWarning('A cadastral ID is required for a private apartment.');
      return;
    }
    this.saving = true;
    this.cdr.markForCheck();

    this.api
      .updateApartment(apt.su_id, {
        aptName: this.editName.trim(),
        buildingUnitType: this.editType,
        cadastralId: this.isEditPrivate ? this.editCadastral.trim() : '',
      })
      .subscribe({
        next: () => {
          this.saving = false;
          this.dirty = true;
          this.notify.showSuccess('Apartment updated.');
          this.loadData(apt.su_id);
        },
        error: (err) => {
          this.saving = false;
          qaErr('UnitComp', `update FAILED (HTTP ${err?.status})`, err?.error ?? err);
          this.notify.showError(err?.error?.error || err?.error?.detail || 'Update failed.');
          this.cdr.markForCheck();
        },
      });
  }

  assignSelected(): void {
    const apt = this.selectedApartment;
    if (!apt) {
      this.notify.showWarning('Select an apartment first.');
      return;
    }
    const picked = this.pool.filter((u) => u.selected);
    if (picked.length === 0) {
      this.notify.showWarning('Select at least one unassigned room.');
      return;
    }
    this.saving = true;
    this.cdr.markForCheck();

    const payload = {
      buildingSuId: this.data.buildingSuId,
      lsbuSuId: apt.su_id,
      unitSuIds: picked.map((u) => u.su_id),
    };
    qa('UnitComp', 'assign request', payload);

    this.api.assignUnitsToLsbu(payload).subscribe({
      next: (res) => {
        this.saving = false;
        this.dirty = true;
        qa('UnitComp', 'assign OK', res);
        this.notify.showSuccess(
          `Assigned ${picked.length} room(s) to ${this.apartmentLabel(apt)}.`,
        );
        this.loadData(apt.su_id);
      },
      error: (err) => {
        this.saving = false;
        qaErr('UnitComp', `assign FAILED (HTTP ${err?.status})`, err?.error ?? err);
        this.notify.showError(err?.error?.error || err?.error?.detail || 'Assignment failed.');
        this.cdr.markForCheck();
      },
    });
  }

  // ---------------------------------------------------------------- three.js
  private initScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xeef2f6);

    const el = this.sceneContainer.nativeElement;
    const w = el.clientWidth || 700;
    const h = el.clientHeight || 500;

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1_000_000);
    this.camera.up.set(0, 0, 1);

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    el.appendChild(canvas);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(80, 80, 160);
    this.scene.add(dir);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.maxPolarAngle = Math.PI;

    this.renderer.domElement.addEventListener('click', this.onCanvasClick);
    this.animate();
  }

  private drawRooms(cityjson: any): void {
    if (!cityjson?.CityObjects || !cityjson?.vertices) return;
    this.buildingGroup = new THREE.Group();

    const t = cityjson.transform;
    const verts: number[][] = (cityjson.vertices as number[][]).map((v) => [
      t ? v[0] * t.scale[0] + t.translate[0] : v[0],
      t ? v[1] * t.scale[1] + t.translate[1] : v[1],
      t ? v[2] * t.scale[2] + t.translate[2] : v[2],
    ]);

    const box = new THREE.Box3();
    verts.forEach((v) => box.expandByPoint(new THREE.Vector3(v[0], v[1], v[2])));
    const c = box.getCenter(new THREE.Vector3());

    Object.entries<any>(cityjson.CityObjects).forEach(([roomId, obj]) => {
      if (!obj.geometry || obj.type === 'Building') return;
      obj.geometry.forEach((geom: any) => {
        this.traverse(geom.boundaries, (ring) => {
          const g = this.ringGeom(ring, verts, c);
          if (!g) return;
          const mesh = new THREE.Mesh(
            g,
            new THREE.MeshStandardMaterial({
              color: this.COLOR_DEFAULT,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.9,
            }),
          );
          this.meshRoom.set(mesh, roomId);
          if (!this.roomMeshes.has(roomId)) this.roomMeshes.set(roomId, []);
          this.roomMeshes.get(roomId)!.push(mesh);
          this.buildingGroup.add(mesh);
        });
      });
    });

    this.scene.add(this.buildingGroup);

    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 5);
    const d = maxDim * 1.8;
    this.camera.position.set(-d, -d, d);
    this.camera.lookAt(0, 0, 0);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private ringGeom(indices: number[], vertices: number[][], c: THREE.Vector3) {
    if (!Array.isArray(indices) || indices.length < 3) return null;
    const pts = indices.map((i) => vertices[i]).filter(Boolean);
    if (pts.length < 3) return null;
    const local = pts.map((p) => [p[0] - c.x, p[1] - c.y, p[2] - c.z]);
    const n = this.normal(local);
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
    const flat = local.map((p) => [p[a1], p[a2]]).flat();
    const tris = earcut(flat);
    if (!tris.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(local.flat(), 3));
    g.setIndex(tris);
    g.computeVertexNormals();
    return g;
  }

  private traverse(b: any, cb: (ring: number[]) => void): void {
    if (!b) return;
    if (Array.isArray(b[0])) b.forEach((x: any) => this.traverse(x, cb));
    else if (typeof b[0] === 'number') cb(b);
  }

  private normal(p: number[][]): number[] {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return [nx, ny, nz];
  }

  private animate = (): void => {
    if (this.renderer && this.scene && this.camera) {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.animationId = requestAnimationFrame(this.animate);
    }
  };

  // ---------------------------------------------------------------- selection (two-way)
  private onCanvasClick = (event: MouseEvent): void => {
    if (!this.buildingGroup) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.buildingGroup.children, true);
    if (!hits.length) return;
    const roomId = this.meshRoom.get(hits[0].object as THREE.Mesh);
    if (!roomId) return;

    // 1) a pool room → toggle it for assignment
    const unit = this.pool.find((u) => u.roomId === roomId);
    if (unit) {
      unit.selected = !unit.selected;
      this.repaintAll();
      qa('UnitComp', '3D→list highlight', { roomId, selected: unit.selected, su_id: unit.su_id });
      this.cdr.markForCheck();
      return;
    }

    // 2) a room already in an apartment → select that apartment
    const owner = this.apartments.find((a) => a.rooms.includes(roomId));
    if (owner) {
      this.selectApartment(owner);
      return;
    }
    qaErr('UnitComp', '3D pick: room neither in pool nor an apartment', { roomId });
  };

  /** Row click → toggle a pool unit + highlight (two-way). */
  toggleUnit(unit: PoolUnit): void {
    unit.selected = !unit.selected;
    this.repaintAll();
    const meshes = this.roomMeshes.get(unit.roomId)?.length ?? 0;
    qa('UnitComp', 'list→3D highlight', {
      roomId: unit.roomId,
      selected: unit.selected,
      meshesForRoom: meshes,
    });
    if (meshes === 0) {
      qaErr('UnitComp', 'list→3D highlight: 0 meshes for this roomId (mesh not found)', {
        roomId: unit.roomId,
      });
    }
  }

  /** Select / deselect every room on a floor at once. */
  toggleFloor(group: { units: PoolUnit[] }): void {
    const allSel = group.units.every((u) => u.selected);
    for (const u of group.units) u.selected = !allSel;
    this.repaintAll();
    qa('UnitComp', 'toggle floor', { count: group.units.length, selected: !allSel });
  }

  /** Row hover → emphasise the mesh momentarily for confirmation. */
  hoverUnit(unit: PoolUnit | null): void {
    this.repaintAll();
    if (unit) {
      const meshes = this.roomMeshes.get(unit.roomId) || [];
      meshes.forEach((m) => (m.material as THREE.MeshStandardMaterial).color.set(this.COLOR_HOVER));
    }
  }

  /** Repaint every mesh: members green, selected-pool amber, the rest default. */
  private repaintAll(): void {
    this.meshRoom.forEach((_roomId, mesh) => {
      (mesh.material as THREE.MeshStandardMaterial).color.set(this.COLOR_DEFAULT);
    });
    if (this.selectedApartment) {
      for (const roomId of this.selectedApartment.rooms) {
        (this.roomMeshes.get(roomId) || []).forEach((m) =>
          (m.material as THREE.MeshStandardMaterial).color.set(this.COLOR_MEMBER),
        );
      }
    }
    for (const u of this.pool) {
      if (u.selected) {
        (this.roomMeshes.get(u.roomId) || []).forEach((m) =>
          (m.material as THREE.MeshStandardMaterial).color.set(this.COLOR_SELECTED),
        );
      }
    }
  }

  // ---------------------------------------------------------------- close
  cancel(): void {
    this.dialogRef.close(this.dirty);
  }
}

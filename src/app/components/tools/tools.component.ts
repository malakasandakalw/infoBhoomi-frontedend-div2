import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  inject,
  OnDestroy,
  OnInit,
  DestroyRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule } from '@angular/material/dialog';
import * as turf from '@turf/turf'; // <<< ADD THIS IMPORT. You need Turf.js here.
import type { Position } from 'geojson';
import { Feature } from 'ol';
import { Coordinate } from 'ol/coordinate'; // Import Coordinate
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import { Draw, Snap } from 'ol/interaction';
import { DrawEvent } from 'ol/interaction/Draw';
import VectorLayer from 'ol/layer/Vector'; // Import VectorLayer
import { get, transform } from 'ol/proj';
import { firstValueFrom, map, Observable, Subscription } from 'rxjs';

import { v4 as uuidv4 } from 'uuid';

// Services
import VectorSource from 'ol/source/Vector'; // Import VectorSource
import { AppStateService } from '../../services/app-state.service';
import { ActiveTool, DrawService } from '../../services/draw.service';
import { FeatureService } from '../../services/feature.service';
import { LayerService } from '../../services/layer.service';
import { MapService } from '../../services/map.service';
import { NotificationService } from '../../services/notifications.service';
import { SplitService } from '../../services/split.service';
import { ToolbarActionService } from '../../services/toolbar-action.service';

// Models and Types
import { Geometry } from 'ol/geom';
import { ProjectionLike } from 'ol/proj';
import { APIsService } from '../../services/api.service';
import { SidebarControlService } from '../../services/sidebar-control.service';
import { UserService } from '../../services/user.service';
import { GeomService } from '../../services/geom.service';
import { MatDialog } from '@angular/material/dialog';
import { Subject } from 'rxjs';
import { Circle as CircleStyle, Fill, Icon, Stroke, Style, Text } from 'ol/style';
import { getLength } from 'ol/sphere';
import { unByKey } from 'ol/Observable';
import { EventsKey } from 'ol/events';
import {
  ProgressDialogComponent,
  ProgressDialogData,
  ProgressUpdate,
} from '../shared/progress-dialog/progress-dialog.component';

type GeoTagType = {
  type: string;
  label: string;
  icon: string;
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-tools',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatTooltipModule, MatDialogModule],
  templateUrl: './tools.component.html',
  styleUrls: ['./tools.component.css'],
})
export class ToolsComponent implements OnInit, OnDestroy {
  private sidebarService = inject(SidebarControlService);
  private destroyRef = inject(DestroyRef);
  public activeTool$: Observable<ActiveTool>;
  public isSnappingEnabled$: Observable<boolean>;
  public isDrawingReady$: Observable<boolean>;
  public canUndo$: Observable<boolean>;

  public canMerge$: Observable<boolean>;

  public isSaving = false;

  private toolbarSaveSubscription: Subscription | null = null;

  isMenuOpen = false; // For local UI state of the menu button itself
  isPanActive = false; // For local UI state of the pan button
  public isSplitting = false; // Add this property to your component

  add: boolean = false;
  edit: boolean = false;
  delete: boolean = false;
  view: boolean = false;

  public isSidebarClosed = false;

  public extendWidth = false;
  public activeUtilityTool: 'distance' | 'angle' | 'geotag' | null = null;
  public showGeoTagMenu = false;
  public selectedGeoTagType: GeoTagType | null = null;
  public geoTagContextMenu: {
    visible: boolean;
    x: number;
    y: number;
    feature: Feature<Point> | null;
  } = { visible: false, x: 0, y: 0, feature: null };

  public readonly geoTagTypes: GeoTagType[] = [
    { type: 'tree', label: 'Tree', icon: 'park' },
    { type: 'garbage', label: 'Garbage Collection', icon: 'delete' },
    { type: 'fire', label: 'Fire Risk', icon: 'local_fire_department' },
    { type: 'drainage', label: 'Drainage Issue', icon: 'water_drop' },
    { type: 'street_light', label: 'Street Light', icon: 'lightbulb' },
    { type: 'road_damage', label: 'Road Damage', icon: 'traffic' },
    { type: 'other', label: 'Other', icon: 'place' },
  ];

  private measureLayer: VectorLayer<VectorSource<Feature<Geometry>>> | null = null;
  private geoTagLayer: VectorLayer<VectorSource<Feature<Point>>> | null = null;
  private activeDraw: Draw | null = null;
  private mapClickKey: EventsKey | null = null;
  private contextMenuHandler: ((evt: MouseEvent) => void) | null = null;

  constructor(
    private mapService: MapService,
    private drawService: DrawService,
    private layerService: LayerService,
    private notifications: NotificationService,
    private featureService: FeatureService,
    private splitService: SplitService,
    private cdr: ChangeDetectorRef,
    private appStateService: AppStateService,
    private toolbarActionService: ToolbarActionService,
    private userService: UserService,
    private apiService: APIsService,
    private geomService: GeomService,
    private dialog: MatDialog,
  ) {
    this.activeTool$ = this.drawService.activeTool$;
    this.isSnappingEnabled$ = this.drawService.isSnappingEnabled$;
    this.isDrawingReady$ = this.drawService.interactionsReady$; // Subscribe to readiness
    this.canUndo$ = this.appStateService.canUndo$;

    this.sidebarService.isClosed$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((closed) => {
      this.isSidebarClosed = closed;

      this.cdr.markForCheck();
    });

    this.drawService.deselectedFeature$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.extendWidth = false;

      this.cdr.markForCheck();
    });

    // <<< NEW: Logic to determine if the merge action is possible
    this.canMerge$ = this.drawService.selectedFeatures$.pipe(
      map((features) => {
        // Condition: More than 1 feature selected, and they are all polygons.
        return (
          features.length >= 2 &&
          features.every((f) => f.getGeometry()?.getType().includes('Polygon'))
        );
      }),
    );
  }

  ngOnInit(): void {
    this.toolbarSaveSubscription = this.toolbarActionService.saveAllTriggered$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.saveAllChanges());
    this.mapService.mapInstance$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((map) => {
      if (!map) return;
      this.ensureUtilityLayers();
      this.loadGeoTags();
      this.installGeoTagContextMenu();
    });
  }

  ngAfterViewInit(): void {
    this.apiService.getToolbarPermission().subscribe({
      next: (res: any) => {
        this.add = res[0].add;
        this.featureService.setAddPermission(res[0].add);
        this.edit = res[0].edit;
        this.delete = res[0].delete;
        this.view = res[0].view;

        this.cdr.markForCheck();
      },
      error: (err) => {
        // If permissions can't be fetched, default to fully enabled so the
        // toolbar doesn't silently vanish when the backend is temporarily down.
        console.warn('Could not load toolbar permissions, defaulting to enabled:', err?.status);
        this.view = true;
        this.add = true;
        this.edit = true;
        this.delete = true;
        this.featureService.setAddPermission(true);
      },
    });
  }

  ngOnDestroy(): void {
    this.cleanupUtilityInteractions();
    if (this.contextMenuHandler) {
      this.mapService.mapInstance
        ?.getViewport()
        .removeEventListener('contextmenu', this.contextMenuHandler, true);
    }
    this.drawService.setActiveTool(null);
  }

  canAdd(): boolean {
    return this.add ?? false;
  }

  canEdit(): boolean {
    return this.edit ?? false;
  }

  canDelete(): boolean {
    return this.delete ?? false;
  }

  canView(): boolean {
    return this.view ?? false;
  }

  // Getter for template convenience, though direct async pipe is better
  public get getActiveDrawType(): 'Point' | 'LineString' | 'Polygon' | null {
    const currentTool = this.drawService._activeTool.value; // Access BehaviorSubject's value
    if (currentTool?.type === 'draw') {
      return currentTool.drawType;
    }
    return null;
  }

  onDrawClick(type: 'Point' | 'LineString' | 'Polygon'): void {
    const currentTool = this.drawService._activeTool.value;
    if (currentTool?.type === 'draw' && currentTool.drawType === type) {
      this.drawService.setActiveTool(null); // Toggle off
    } else {
      this.drawService.setActiveTool({ type: 'draw', drawType: type });
    }
  }

  onModifyClick(): void {
    const currentTool = this.drawService._activeTool.value;
    if (currentTool?.type === 'modify') {
      this.drawService.setActiveTool(null); // Toggle off
    } else {
      this.drawService.setActiveTool({ type: 'modify' });
    }
  }

  onToggleMergeTool(): void {
    const currentTool = this.drawService._activeTool.value;
    if (currentTool?.type === 'merge') {
      this.drawService.setActiveTool(null); // Toggle off
    } else {
      this.drawService.setActiveTool({ type: 'merge' });
    }
  }

  // <<< NEW: This method EXECUTES the merge action
  async onExecuteMerge(): Promise<void> {
    // A quick check, though the button should be disabled via `canMerge$`
    if ((await firstValueFrom(this.canMerge$)) === false) {
      this.notifications.showWarning('Select at least two polygons to merge.');
      return;
    }
    await this.drawService.mergeSelectedPolygons();
  }

  onSelectClick(): void {
    const currentTool = this.drawService._activeTool.value;
    if (currentTool?.type === 'select' && currentTool.multi === false) {
      // Assuming this button is for multi-select
      this.drawService.setActiveTool(null); // Toggle off
    } else {
      this.drawService.setActiveTool({ type: 'select', multi: false });
    }
  }

  toggleSnapping(): void {
    this.drawService.toggleSnapping();
  }

  public async onMergeClick(): Promise<void> {
    const currentTool = this.drawService.getCurrentActiveTool();

    if (currentTool?.type === 'merge') {
      const selectedFeatures = this.drawService._selectedFeatures.value;
      const isMergeActionPossible =
        selectedFeatures.length >= 2 &&
        selectedFeatures.every((f) => f.getGeometry()?.getType().includes('Polygon'));
      if (isMergeActionPossible) {
        // A valid selection exists, so execute the merge.
        await this.drawService.mergeSelectedPolygons();
      } else {
        // No valid selection, so just deactivate the tool.
        this.drawService.setActiveTool(null);
        this.notifications.showInfo(
          'Merge tool deactivated. Select at least two polygons to merge.',
        );
      }
    } else {
      // Any other tool is active, or no tool is active.
      // Activate the merge tool to allow selection.
      this.drawService.setActiveTool({ type: 'merge' });
    }
  }

  public get getActiveToolType(): 'draw' | 'select' | 'modify' | 'split' | 'merge' | null {
    const currentTool = this.drawService._activeTool.value;
    return currentTool ? currentTool.type : null;
  }

  public get getCurrentDrawType(): 'Point' | 'LineString' | 'Polygon' | null {
    const currentTool = this.drawService._activeTool.value;
    if (currentTool?.type === 'draw') {
      return currentTool.drawType;
    }
    return null;
  }

  /**
   * Improved splitPolygon function with better error handling,
   * cleaner code structure, and enhanced documentation
   */
  async splitPolygon(): Promise<void> {
    // 1. Prevent Re-entry: If a split is already in progress, do nothing.
    if (this.isSplitting) {
      this.notifications.showInfo('A split operation is already in progress.');
      return;
    }

    if (!this.drawService.areInteractionsReady) {
      this.notifications.showWarning('Split tool is not ready, please wait.');
      return;
    }

    // Pre-flight checks...
    const targetLayerId = this.layerService.getSelectedCurrentLayerIdForDrawing();
    if (targetLayerId === null) {
      this.notifications.showWarning('Please select a target layer for the split results.');
      return;
    }

    this.isSplitting = true;
    this.notifications.showInfo('Split Tool: First, select the polygon to split.');

    try {
      // Step 1: Select the Polygon to Split
      this.notifications.showInfo('Split Tool: First, select the polygon to split.');
      const polygonToSplit = await this.selectPolygonToSplit(); // now in web mercator projection

      // Step 2: Prepare Snapping Source (for points on the same layer)
      const snapSource = await this.prepareSnapSource(polygonToSplit);

      this.notifications.showInfo('Polygon selected. Now, draw the split line.');

      const rawSplitLineFeature = await firstValueFrom(
        // Use the DrawService to handle the temporary drawing interactions.
        this.drawService.drawTemporaryFeature('LineString', snapSource),
      );

      // Step 4: Transform geometries for the service
      // This is the call to the function in question.
      // It takes the raw user input and prepares it for the split service.
      const processedGeometries = await this.processGeometriesForSplit(
        // this gives wgs84 coorindates
        rawSplitLineFeature,
        polygonToSplit as Feature<Polygon>,
      );

      // Step 5: Perform the split
      await this.performSplit(polygonToSplit as Feature<Polygon>, processedGeometries);

      this.notifications.showSuccess('Polygon split successfully!');
    } catch (error: any) {
      this.handleSplitError(error);
    } finally {
      this.isSplitting = false;
      this.drawService.setActiveTool(null);
    }
  }

  // 2. A combined drawing and processing function. This is cleaner.
  private async drawAndProcessSplitLine(
    snapSource: VectorSource,
    polygonGeom: Polygon,
  ): Promise<Feature<LineString>> {
    // A. DRAW THE RAW LINE
    const rawLineFeature = await firstValueFrom(
      this.drawService.drawTemporaryFeature('LineString', snapSource),
    );

    // B. PROCESS THE RAW LINE
    const rawLineGeom = rawLineFeature.getGeometry()!;

    // Snap endpoints to the boundary to create a precise base
    const rawCoords = rawLineGeom.getCoordinates();
    const preciseStart = polygonGeom.getClosestPoint(rawCoords[0]);
    const preciseEnd = polygonGeom.getClosestPoint(rawCoords[rawCoords.length - 1]);
    const preciseLineGeom = new LineString([preciseStart, ...rawCoords.slice(1, -1), preciseEnd]);

    // Extend the precise line to guarantee intersection
    const extendedLineFeature = this.extendSplitLineBeyondPolygon(
      new Feature(preciseLineGeom),
      polygonGeom,
    );

    return extendedLineFeature;
  }

  /**
   * Selects and validates the polygon to split
   */
  private async selectPolygonToSplit(): Promise<Feature<Polygon>> {
    const selectedFeature = await firstValueFrom(this.drawService.selectSingleFeature('Polygon'));
    const olPolygonGeom = selectedFeature.getGeometry();
    if (!olPolygonGeom) {
      throw new Error('Selected feature has no geometry.');
    }

    const turfPolygonToValidate = turf.polygon((olPolygonGeom as Polygon).getCoordinates());
    const kinks = turf.kinks(turfPolygonToValidate);
    if (kinks.features.length > 0) {
      console.error(
        'Validation failed: The selected polygon is invalid because it self-intersects.',
        kinks.features,
      );
      throw new Error(
        'Cannot split this polygon because it has an invalid shape (it crosses over itself).',
      );
    }

    return selectedFeature as Feature<Polygon>;
  }

  /**
   * Prepares the snap source with polygon and related point features
   */

  private async prepareSnapSource(polygonToSplit: Feature<Geometry>): Promise<VectorSource> {
    let featuresForSnapping: Feature<Geometry>[] = [polygonToSplit];

    const layerId = polygonToSplit.get('layer_id');

    if (layerId !== undefined && layerId !== null) {
      const pointFeatures = this.getPointFeaturesFromLayer(Number(layerId));
      if (pointFeatures.length > 0) {
        console.log(
          `Adding ${pointFeatures.length} Point features from layer ${layerId} to the snap source.`,
        );
        featuresForSnapping = featuresForSnapping.concat(pointFeatures);
      }
    } else {
      console.warn(
        "Selected polygon has no 'layer_id'. Snapping will only occur on the polygon boundary.",
      );
    }

    return new VectorSource({ features: featuresForSnapping });
  }

  /**
   * Gets point features from a specific layer
   */
  private getPointFeaturesFromLayer(layerId: number): Feature<Geometry>[] {
    const sourceLayer = this.drawService.findLayerOnMap(layerId);
    const source = sourceLayer?.getSource();

    if (!source) {
      return [];
    }

    return source.getFeatures().filter((f) => f.getGeometry()?.getType() === 'Point');
  }

  /**
   * Draws the split line with snapping enabled
   */
  private async drawSplitLine(
    snapSource: VectorSource,
    polygonGeom: Polygon,
  ): Promise<Feature<Geometry>> {
    this.notifications.showInfo(
      'Polygon selected. Draw the split line. Snapping to points is active.',
    );

    const splitLineFeature = await this.drawLineWithFirstPointSnapping(snapSource, polygonGeom);
    const olUserDrawnLine = splitLineFeature.getGeometry() as LineString;

    if (!(olUserDrawnLine instanceof LineString)) {
      throw new Error('The drawn feature is not a valid line for splitting.');
    }

    if (olUserDrawnLine.getCoordinates().length < 2) {
      throw new Error('Split line must have at least two points.');
    }

    return splitLineFeature;
  }

  // ADD THIS NEW, CENTRALIZED PROCESSING FUNCTION
  /**
   * Takes raw geometries, validates them, and prepares them for the split service.
   */
  // in tools.component.ts

  private async processGeometriesForSplit(
    rawUserLine: Feature<LineString>, // this is ne web mercator projection
    targetPolygon: Feature<Polygon>, // this is in web mercator projection
  ): Promise<{ lineForService: LineString; polygonForService: Polygon }> {
    // --- Define our known projections ---
    const MAP_PROJECTION = 'EPSG:3857'; // All geometries from the map are in this CRS.
    const DATA_PROJECTION = 'EPSG:4326'; // Turf.js and the backend expect this CRS.

    // 1. Get geometries. We know they are in MAP_PROJECTION.
    const polygonGeom = targetPolygon.getGeometry()!;
    let lineGeom = rawUserLine.getGeometry()!;

    // === STEP 1: Extend the drawn line well beyond the polygon ===
    // We do NOT snap endpoints to the boundary here. Snapping a point exactly onto
    // the boundary in EPSG:3857 and then transforming to EPSG:4326 causes the point
    // to drift slightly off the boundary (Mercator is non-linear), so
    // turf.lineIntersect finds 0–1 intersections instead of 2 and the split fails.
    // Instead we extend both ends far outside the polygon so the line crosses the
    // boundary cleanly from outside → inside → outside, and turf finds 2 crossings.
    const rawCoords = lineGeom.getCoordinates();
    if (rawCoords.length < 2) {
      throw new Error('Split line must have at least two points.');
    }
    lineGeom = this.extendLineGeometry(lineGeom, polygonGeom);

    // === STEP 2: Transform the finalized geometries to DATA_PROJECTION for the service ===
    console.log('[Split Prep] Transforming finalized geometries to EPSG:4326 for service.');

    // We clone before transforming to avoid modifying the original features on the map.
    const lineForService = lineGeom
      .clone()
      .transform(MAP_PROJECTION, DATA_PROJECTION) as LineString;
    const polygonForService = polygonGeom
      .clone()
      .transform(MAP_PROJECTION, DATA_PROJECTION) as Polygon;

    // === STEP 3: Final validation with Turf.js (now with correct WGS84 data) ===
    const turfLine = turf.lineString(lineForService.getCoordinates());
    const turfPolygon = turf.polygon(polygonForService.getCoordinates());
    const intersections = turf.lineIntersect(turfLine, turfPolygon);

    if (intersections.features.length < 2) {
      console.error('Final validation failed. Intersections found:', intersections.features.length);
      throw new Error(
        `The split line must cross the polygon boundary in at least two distinct places. Please redraw the line.`,
      );
    }

    console.log('[Split Prep] Geometries processed, transformed, and validated successfully.');
    return { lineForService, polygonForService };
  }

  private extendLineGeometry(lineGeom: LineString, polygonGeom: Polygon): LineString {
    const coords = lineGeom.getCoordinates();
    if (coords.length < 2) return lineGeom;

    // Calculate diagonal in the current projection's units (meters)
    const extent = polygonGeom.getExtent();
    const polygonDiagonal = Math.sqrt(
      Math.pow(extent[2] - extent[0], 2) + Math.pow(extent[3] - extent[1], 2),
    );
    const extensionDistance = polygonDiagonal * 1.5;

    const startPoint = coords[0];
    const secondPoint = coords[1];
    const endPoint = coords[coords.length - 1];
    const secondLastPoint = coords[coords.length - 2];

    // Vector math for start point
    const startDir = [startPoint[0] - secondPoint[0], startPoint[1] - secondPoint[1]];
    const startMag = Math.sqrt(startDir[0] ** 2 + startDir[1] ** 2);
    const extendedStart =
      startMag > 0
        ? [
            startPoint[0] + (startDir[0] / startMag) * extensionDistance,
            startPoint[1] + (startDir[1] / startMag) * extensionDistance,
          ]
        : startPoint;

    // Vector math for end point
    const endDir = [endPoint[0] - secondLastPoint[0], endPoint[1] - secondLastPoint[1]];
    const endMag = Math.sqrt(endDir[0] ** 2 + endDir[1] ** 2);
    const extendedEnd =
      endMag > 0
        ? [
            endPoint[0] + (endDir[0] / endMag) * extensionDistance,
            endPoint[1] + (endDir[1] / endMag) * extensionDistance,
          ]
        : endPoint;

    // Replace the original endpoints with the extended ones.
    // We use slice(1, -1) to keep only the interior waypoints (if any), so the
    // final line is [far_outside, ...intermediates, far_outside].
    // This avoids having the original endpoint (which may be exactly on the polygon
    // boundary) as an interior waypoint, which can cause turf.lineIntersect to
    // detect a "touch" rather than a "crossing" after reprojection to EPSG:4326.
    const extendedCoords = [extendedStart, ...coords.slice(1, -1), extendedEnd];

    console.log(`Extended line geometry from ${coords.length} to ${extendedCoords.length} points.`);
    return new LineString(extendedCoords);
  }

  /**
   * Extends the start and end of a LineString outwards along its trajectory.
   * This version uses Turf.js bearing and destination for accurate angle calculations,
   * which correctly handles multi-vertex lines and prevents distortion.
   *
   * @param lineFeature - The feature containing the line to extend.
   * @param polygonGeometry - The polygon used to calculate an appropriate extension distance.
   * @returns A new Feature with the extended LineString geometry.
   */
  private extendLine(
    lineFeature: Feature<LineString>,
    polygonGeometry: Polygon,
  ): Feature<LineString> {
    const lineGeom = lineFeature.getGeometry()!;
    const originalCoords = lineGeom.getCoordinates();

    if (originalCoords.length < 2) {
      console.warn('Cannot extend a line with fewer than 2 points.');
      return lineFeature;
    }

    // Calculate a massive extension distance to guarantee crossing.
    const polygonDiagonal = Math.sqrt(
      Math.pow(polygonGeometry.getExtent()[2] - polygonGeometry.getExtent()[0], 2) +
        Math.pow(polygonGeometry.getExtent()[3] - polygonGeometry.getExtent()[1], 2),
    );
    const extensionDistance = polygonDiagonal * 1.5; // 150% is very safe.

    const turfLine = turf.lineString(originalCoords);

    // --- Extend Start Point ---
    // The bearing is calculated from the second point TO the first point to get the "backwards" direction.
    const startBearing = turf.bearing(originalCoords[1], originalCoords[0]);
    // Calculate the new start point by moving from the original start point along the backwards bearing.
    const extendedStartPoint = turf.destination(
      originalCoords[0],
      extensionDistance,
      startBearing,
      { units: 'meters' },
    ).geometry.coordinates;

    // --- Extend End Point ---
    // The bearing is calculated from the second-to-last point TO the last point to get the "forwards" direction.
    const endBearing = turf.bearing(
      originalCoords[originalCoords.length - 2],
      originalCoords[originalCoords.length - 1],
    );
    // Calculate the new end point by moving from the original end point along the forwards bearing.
    const extendedEndPoint = turf.destination(
      originalCoords[originalCoords.length - 1],
      extensionDistance,
      endBearing,
      { units: 'meters' },
    ).geometry.coordinates;

    // --- Construct the New, Extended Line ---
    // This correctly uses only the intermediate points from the original line.
    const extendedCoords = [extendedStartPoint, ...originalCoords.slice(1, -1), extendedEndPoint];

    const extendedGeometry = new LineString(extendedCoords);
    const newFeature = new Feature(extendedGeometry);

    if (lineFeature.getProperties()) {
      newFeature.setProperties(lineFeature.getProperties());
    }

    console.log(`[ToolsComponent] Extended line using precise bearing/destination.`);
    return newFeature;
  }

  /**
   * Processes the user-drawn split line to create a precise, extended line ready for the split service.
   */
  private async processSplit(
    userDrawnLine: LineString,
    polygonGeom: Polygon,
  ): Promise<{
    lineForService: LineString;
    polygonForService: Polygon;
  }> {
    // 1. Get Projections
    const mapProjection = (await this.drawService.getMap()).getView().getProjection();
    const dataProjection = get('EPSG:4326');
    if (!dataProjection) {
      throw new Error('Could not get EPSG:4326 projection');
    }

    // Transform to the projection used for calculations (EPSG:4326)
    const transformedPolygon = polygonGeom
      .clone()
      .transform(mapProjection, dataProjection) as Polygon;
    let transformedLine = userDrawnLine
      .clone()
      .transform(mapProjection, dataProjection) as LineString;

    // ==> THE FIX: Introduce a small "nudge" to the line to avoid perfect vertex alignment <==
    // This is a robust way to handle geometric edge cases.
    // We'll shift the line by 1cm to the northeast.
    const nudgedLineFeature = turf.transformTranslate(
      turf.lineString(transformedLine.getCoordinates()), // The feature to move
      0.01, // distance in meters
      45, // direction in degrees (45 = northeast)
      { units: 'meters' },
    );

    // Update our line geometry with the new, slightly shifted coordinates
    transformedLine = new LineString(nudgedLineFeature.geometry.coordinates);
    console.log(
      '[ToolsComponent] Applied a small nudge to the split line to prevent vertex alignment issues.',
    );

    // Perform the intersection check for a fast failure message
    const turfLine = turf.lineString(transformedLine.getCoordinates());
    const turfPolygon = turf.polygon(transformedPolygon.getCoordinates());
    const intersections = turf.lineIntersect(turfLine, turfPolygon);

    if (intersections.features.length < 2) {
      throw new Error(
        `Split line must cross the polygon boundary in at least two distinct places. Found ${intersections.features.length} intersection(s). Please try drawing the line again.`,
      );
    }

    console.log(
      `[ToolsComponent] Found ${intersections.features.length} intersections. Proceeding with split.`,
    );

    return {
      lineForService: transformedLine,
      polygonForService: transformedPolygon,
    };
  }
  // Helper: find the index of the closest coordinate in ring
  findNearestIndex(ring: Position[], target: Position): number {
    let minDist = Infinity;
    let minIdx = 0;
    for (let i = 0; i < ring.length; i++) {
      const dist = turf.distance(turf.point(ring[i]), turf.point(target));
      if (dist < minDist) {
        minDist = dist;
        minIdx = i;
      }
    }
    return minIdx;
  }

  /**
   * Creates the final split line with precise intersection points
   */
  private createFinalSplitLine(
    intersections: any,
    preciseLine: LineString,
    mapProjection: any,
    dataProjection: any,
  ): LineString {
    const intermediatePoints = preciseLine.getCoordinates().slice(1, -1);

    const finalSplitLineCoords = [
      intersections.features[0].geometry.coordinates,
      ...intermediatePoints.map((coord: any) => transform(coord, mapProjection, dataProjection)),
      intersections.features[intersections.features.length - 1].geometry.coordinates,
    ];

    return new LineString(finalSplitLineCoords);
  }

  /**
   * Performs the actual split operation
   */
  // in tools.component.ts

  /**
   * Performs the actual split operation using the SplitService.
   */
  private async performSplit(
    orgPolygon: Feature<Polygon>,
    processedGeometries: { lineForService: LineString; polygonForService: Polygon },
  ): Promise<void> {
    // 1. Call the SplitService. We know the processed geometries are in EPSG:4326,
    //    which is exactly what the Turf-based service expects.
    const splitResult = this.splitService.splitOperation(
      processedGeometries.lineForService, // This is in EPSG:4326
      processedGeometries.polygonForService, // This is also in EPSG:4326
    );

    if (!splitResult) {
      throw new Error(
        'Split calculation failed. The line may not have split the polygon correctly.',
      );
    }

    // 2. Process the results. The results from the split service will also be
    //    in EPSG:4326. We need to tell the next function how to handle them.
    await this.processSplitResults(orgPolygon, splitResult);
  }

  /**
   * Handles errors during split operation
   */
  private handleSplitError(error: any): void {
    if (error.message?.includes('cancelled')) {
      this.notifications.showInfo('Split operation cancelled.');
    } else {
      console.error('Split operation error:', error);
      this.notifications.showError(`Split failed: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Resets the split state and tools
   */
  private resetSplitState(): void {
    this.isSplitting = false;
    this.drawService.setActiveTool(null);
  }

  //############################################

  private createPreciseSplitLine(
    drawnCoords: Coordinate[],
    polygonGeom: Polygon,
    tolerance: number = 10,
  ): LineString {
    if (drawnCoords.length < 2) {
      throw new Error('Split line must have at least 2 coordinates');
    }

    const start = drawnCoords[0];
    const end = drawnCoords[drawnCoords.length - 1];
    const intermediates = drawnCoords.slice(1, -1);

    // Validate and get precise start point
    const preciseStart = this.validateAndGetPrecisePoint(start, polygonGeom, tolerance, 'start');

    // Validate and get precise end point
    const preciseEnd = this.validateAndGetPrecisePoint(end, polygonGeom, tolerance, 'end');

    // Ensure start and end points are different
    if (this.arePointsEqual(preciseStart, preciseEnd, 0.001)) {
      throw new Error(
        'Start and end points are too close together after snapping to polygon boundary',
      );
    }

    // Log the adjustments made for debugging
    const startDistance = this.calculateDistance(start, preciseStart);
    const endDistance = this.calculateDistance(end, preciseEnd);

    if (startDistance > 0.001 || endDistance > 0.001) {
      console.log(
        `Split line adjusted: start moved ${startDistance.toFixed(3)} units, end moved ${endDistance.toFixed(3)} units`,
      );
    }

    return new LineString([preciseStart, ...intermediates, preciseEnd]);
  }

  private validateAndGetPrecisePoint(
    originalPoint: Coordinate,
    polygonGeom: Polygon,
    tolerance: number,
    pointType: 'start' | 'end',
  ): Coordinate {
    // Get the closest point on the polygon boundary
    const closestPoint = polygonGeom.getClosestPoint(originalPoint);

    if (!closestPoint) {
      throw new Error(`Failed to find closest point on polygon for ${pointType} point`);
    }

    // Calculate distance between original point and closest point on boundary
    const distance = this.calculateDistance(originalPoint, closestPoint);

    // Check if the original point is within tolerance
    if (distance > tolerance) {
      throw new Error(
        `Split line ${pointType} point is too far from polygon boundary. ` +
          `Distance: ${distance.toFixed(2)} units, tolerance: ${tolerance} units. ` +
          `Please draw the line closer to the polygon edge.`,
      );
    }

    // Additional validation: ensure the closest point is actually on the polygon boundary
    if (!this.isPointOnPolygonBoundary(closestPoint, polygonGeom)) {
      throw new Error(`Calculated ${pointType} point is not on polygon boundary`);
    }

    return closestPoint;
  }

  /**
   * Calculates the Euclidean distance between two points
   */
  private calculateDistance(point1: Coordinate, point2: Coordinate): number {
    const dx = point1[0] - point2[0];
    const dy = point1[1] - point2[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Checks if two points are equal within a given tolerance
   */
  private arePointsEqual(point1: Coordinate, point2: Coordinate, tolerance: number): boolean {
    return this.calculateDistance(point1, point2) <= tolerance;
  }

  /**
   * Verifies that a point is actually on the polygon boundary
   */
  private isPointOnPolygonBoundary(
    point: Coordinate,
    polygonGeom: Polygon,
    tolerance: number = 0.001,
  ): boolean {
    try {
      // Get the linear ring (boundary) of the polygon
      const linearRing = polygonGeom.getLinearRing(0); // Exterior ring

      if (!linearRing) {
        return false;
      }

      // Check if point is on the exterior ring
      const distanceToRing = linearRing.getClosestPoint(point);
      if (distanceToRing && this.calculateDistance(point, distanceToRing) <= tolerance) {
        return true;
      }

      // Check interior rings (holes) if they exist
      const interiorRingCount = polygonGeom.getLinearRingCount() - 1;
      for (let i = 1; i <= interiorRingCount; i++) {
        const interiorRing = polygonGeom.getLinearRing(i);
        if (interiorRing) {
          const distanceToInteriorRing = interiorRing.getClosestPoint(point);
          if (
            distanceToInteriorRing &&
            this.calculateDistance(point, distanceToInteriorRing) <= tolerance
          ) {
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      console.warn('Error checking if point is on polygon boundary:', error);
      return false;
    }
  }

  private getSplitLineTolerance(): number {
    // You can make this configurable or calculate based on map scale
    // For now, return a reasonable default (e.g., 10 map units)
    return 10;
  }

  /**
   * Extends a LineString's start and end points outwards along its trajectory.
   * This ensures the line definitively crosses a polygon boundary for reliable intersection.
   *
   * @param preciseLine - The ol/geom/LineString whose endpoints are on the boundary.
   * @returns A new, slightly longer ol/geom/LineString.
   */
  private extendSplitLine(line: LineString): LineString {
    const coords = line.getCoordinates();
    if (coords.length < 2) return line;

    const turfLine = turf.lineString(coords);
    const length = turf.length(turfLine, { units: 'meters' });
    const extendDist = Math.max(1, length * 0.05); // Extend by 5% or 1 meter

    const startBearing = turf.bearing(coords[1], coords[0]);
    const endBearing = turf.bearing(coords[coords.length - 2], coords[coords.length - 1]);

    const extendedStart = turf.destination(coords[0], extendDist, startBearing, {
      units: 'meters',
    });
    const extendedEnd = turf.destination(coords[coords.length - 1], extendDist, endBearing, {
      units: 'meters',
    });

    return new LineString([
      extendedStart.geometry.coordinates,
      ...coords.slice(1, -1),
      extendedEnd.geometry.coordinates,
    ]);
  }

  private async drawLineWithFirstPointSnapping(
    snapSource: VectorSource,
    polygonGeometry: Polygon,
  ): Promise<Feature<LineString>> {
    // Use 'await' to get the actual map object.
    const mapOL = await this.drawService.getMap();
    const resources: {
      drawSource: VectorSource;
      drawLayer: VectorLayer<VectorSource>;
      drawInteraction: Draw | null;
      snapInteraction: Snap;
      keyListener: ((evt: KeyboardEvent) => void) | null;
    } = {
      drawSource: new VectorSource(),
      drawLayer: null!, // Initialize as null, will be set immediately after.
      drawInteraction: null,
      snapInteraction: new Snap({ source: snapSource }),
      keyListener: null,
    };

    return new Promise((resolve, reject) => {
      // Cleanup function
      const cleanup = () => {
        if (mapOL) {
          mapOL.removeLayer(resources.drawLayer);
          if (resources.drawInteraction) {
            resources.drawInteraction.abortDrawing();
            mapOL.removeInteraction(resources.drawInteraction);
          }
          mapOL.removeInteraction(resources.snapInteraction);
        }
        if (resources.keyListener) document.removeEventListener('keydown', resources.keyListener);
      };

      // Create the Draw interaction
      resources.drawInteraction = new Draw({
        source: resources.drawSource,
        type: 'LineString',
        style: this.drawService.getDrawStyle('split'),
      });

      // On draw start, snap the very first point
      resources.drawInteraction.on('drawstart', (evt: DrawEvent) => {
        const geom = evt.feature.getGeometry() as LineString;
        const coords = geom.getCoordinates();
        coords[0] = polygonGeometry.getClosestPoint(coords[0]);
        geom.setCoordinates(coords);
      });

      // On draw end, simply resolve with the raw feature. NO MORE PROCESSING HERE.
      resources.drawInteraction.on('drawend', (evt: DrawEvent) => {
        cleanup();
        resolve(evt.feature as Feature<LineString>);
      });

      // Handle cancellation
      resources.keyListener = (evt: KeyboardEvent) => {
        if (evt.key === 'Escape') {
          cleanup();
          reject(new Error('Drawing was cancelled by user.'));
        }
      };

      // Add interactions to map
      mapOL.addLayer(resources.drawLayer);
      mapOL.addInteraction(resources.drawInteraction);
      mapOL.addInteraction(resources.snapInteraction);
      document.addEventListener('keydown', resources.keyListener);
    });
    // //####
    //   // This is the key to bridging the event-listener world with the async/await world.
    //   return new Promise((resolve, reject) => {

    //     // --- 1. SETUP ---

    //     // Create a temporary layer for visual feedback.
    //     resources.drawLayer = new VectorLayer({
    //       source: resources.drawSource,
    //       style: this.drawService.getDrawStyle('split'),
    //     });
    //     mapOL.addLayer(resources.drawLayer);

    //     // Create the Draw interaction.
    //     resources.drawInteraction = new Draw({
    //       source: resources.drawSource,
    //       type: 'LineString',
    //       style: this.drawService.getDrawStyle('split'),
    //     });
    //     mapOL.addInteraction(resources.drawInteraction);

    //     // Create the Snap interaction.
    //     resources.snapInteraction = new Snap({ source: snapSource });
    //     mapOL.addInteraction(resources.snapInteraction);

    //     let isFirstPoint = true;

    //     // --- 2. DEFINE EVENT HANDLERS ---

    //     // Handler for the 'drawstart' event.
    //     const drawStartHandler = (evt: DrawEvent) => {
    //       if (isFirstPoint) {
    //         // Get the coordinate of the user's first click.
    //         const geometry = evt.feature.getGeometry() as LineString;
    //         const coords = geometry.getCoordinates();
    //         const startCoordinate = coords[0];

    //         // Snap that point mathematically to the polygon's edge.
    //         const snappedStart = polygonGeometry.getClosestPoint(startCoordinate);

    //         // Update the feature's geometry with the precise point.
    //         coords[0] = snappedStart;
    //         geometry.setCoordinates(coords);

    //         isFirstPoint = false;
    //       }
    //     };

    //     // Handler for the 'drawend' event.
    //     const drawEndHandler = (evt: DrawEvent) => {
    //       // Process the drawn line to extend it beyond polygon boundaries
    //       const processedFeature = this.extendSplitLineBeyondPolygon(
    //         evt.feature as Feature<LineString>,
    //         polygonGeometry
    //       );

    //       // The user finished drawing successfully.
    //       cleanup(); // Clean up all listeners and interactions.
    //       resolve(processedFeature); // Resolve with the extended feature
    //     };

    //     // Handler for showing snap preview before the first click.
    //     const pointerMoveHandler = (evt: MapBrowserEvent<any>) => {
    //       if (!isFirstPoint) return; // Only run for the first point.

    //       const coordinate = evt.coordinate;
    //       const closestPoint = polygonGeometry.getClosestPoint(coordinate);

    //       // Calculate pixel distance to see if we are within the snap tolerance.
    //       const pixel = mapOL.getPixelFromCoordinate(coordinate);
    //       const closestPixel = mapOL.getPixelFromCoordinate(closestPoint);
    //       const distance = Math.sqrt(Math.pow(pixel[0] - closestPixel[0], 2) + Math.pow(pixel[1] - closestPixel[1], 2));

    //       // Change the cursor to give the user visual feedback.
    //       const targetElement = mapOL.getTargetElement();
    //       if (distance <= 10) { // Using a 10-pixel tolerance for the preview
    //         targetElement.style.cursor = 'crosshair';
    //       } else {
    //         targetElement.style.cursor = ''; // Use browser default
    //       }
    //     };

    //     // Handler for cancellation via the Escape key.
    //     resources.keyListener = (evt: KeyboardEvent) => {
    //       if (evt.key === 'Escape') {
    //         cleanup(); // Clean up everything.
    //         reject(new Error('Drawing was cancelled by user.')); // Reject the promise.
    //       }
    //     };

    //     // --- 3. DEFINE CLEANUP FUNCTION ---

    //     const cleanup = () => {
    //       console.log("Cleaning up temporary drawing interactions...");
    //       if (mapOL) {
    //         if (resources.drawLayer) mapOL.removeLayer(resources.drawLayer);
    //         if (resources.drawInteraction) mapOL.removeInteraction(resources.drawInteraction);
    //         if (resources.snapInteraction) mapOL.removeInteraction(resources.snapInteraction);
    //         if (resources.pointerMoveKey) mapOL.un('pointermove', pointerMoveHandler);
    //         mapOL.getTargetElement().style.cursor = ''; // Reset cursor
    //       }
    //       if (resources.keyListener) {
    //         document.removeEventListener('keydown', resources.keyListener);
    //       }
    //     };

    //     // --- 4. ATTACH LISTENERS ---

    //     resources.drawInteraction.on('drawstart', drawStartHandler);
    //     resources.drawInteraction.on('drawend', drawEndHandler);
    //     resources.pointerMoveKey = mapOL.on('pointermove', pointerMoveHandler);
    //     document.addEventListener('keydown', resources.keyListener);

    //   }); // End of the Promise constructor
  }

  /**
   * Extends the split line beyond the polygon boundaries while preserving all intermediate points.
   * This ensures the split operation will work cleanly by guaranteeing the line fully crosses the polygon.
   */

  /**
   * Takes raw geometries and prepares them for the split service.
   * This is the central processing function that performs all modifications in order:
   * 1. Snaps line endpoints to the polygon boundary.
   * 2. Extends the snapped line to guarantee a clean intersection.
   * 3. Transforms to the required projection for the service.
   * 4. Validates that the final line intersects twice.
   */
  private async processAndValidateGeometries(
    rawUserLine: Feature<LineString>,
    targetPolygon: Feature<Polygon>,
  ): Promise<{ lineForService: LineString; polygonForService: Polygon }> {
    const polygonGeom = targetPolygon.getGeometry()!;
    const rawLineGeom = rawUserLine.getGeometry()!;

    // Step 1: Create a "precise" line by snapping the raw line's endpoints to the boundary.
    // This ensures the core of our split line is perfectly aligned with the polygon's edges.
    const rawCoords = rawLineGeom.getCoordinates();
    const preciseStart = polygonGeom.getClosestPoint(rawCoords[0]);
    const preciseEnd = polygonGeom.getClosestPoint(rawCoords[rawCoords.length - 1]);
    const preciseLineGeom = new LineString([preciseStart, ...rawCoords.slice(1, -1), preciseEnd]);

    // Step 2: Extend the now-precise line outwards. This is the key to reliable intersection.
    // We re-use your existing extension function for this.
    const extendedLineFeature = this.extendSplitLineBeyondPolygon(
      new Feature(preciseLineGeom), // Pass as a feature
      polygonGeom,
    );

    // We now have the final, prepared line geometry in the MAP'S projection.
    const finalLineGeomForTransform = extendedLineFeature.getGeometry()!;

    // Step 3: Transform to EPSG:4326 for Turf.js and the split service.
    const mapProjection = (await this.drawService.getMap()).getView().getProjection();
    const dataProjection = get('EPSG:4326')!;

    const lineForService = finalLineGeomForTransform
      .clone()
      .transform(mapProjection, dataProjection) as LineString;
    const polygonForService = polygonGeom
      .clone()
      .transform(mapProjection, dataProjection) as Polygon;

    // Step 4: Final validation to ensure everything is correct before calling the service.
    const turfLine = turf.lineString(lineForService.getCoordinates());
    const turfPolygon = turf.polygon(polygonForService.getCoordinates());
    const intersections = turf.lineIntersect(turfLine, turfPolygon);

    if (intersections.features.length < 2) {
      throw new Error(
        `Split line must cross the polygon boundary in at least two distinct places. Found ${intersections.features.length}.`,
      );
    }

    console.log('[ToolsComponent] Geometries processed and validated successfully.');
    return { lineForService, polygonForService };
  }

  private extendSplitLineBeyondPolygon(
    splitLineFeature: Feature<LineString>,
    polygonGeometry: Polygon,
  ): Feature<LineString> {
    const olUserDrawnLine = splitLineFeature.getGeometry()!;
    const originalCoords = olUserDrawnLine.getCoordinates();

    if (originalCoords.length < 2) return splitLineFeature;

    const polygonDiagonal = Math.sqrt(
      Math.pow(polygonGeometry.getExtent()[2] - polygonGeometry.getExtent()[0], 2) +
        Math.pow(polygonGeometry.getExtent()[3] - polygonGeometry.getExtent()[1], 2),
    );
    const extensionDistance = polygonDiagonal * 1.5;

    // ... (rest of the extension logic is the same as the version you posted)
    const startPoint = originalCoords[0];
    const secondPoint = originalCoords[1];
    const startDirection = [startPoint[0] - secondPoint[0], startPoint[1] - secondPoint[1]];
    const startMagnitude = Math.sqrt(startDirection[0] ** 2 + startDirection[1] ** 2);

    const extendedStartPoint =
      startMagnitude > 0
        ? [
            startPoint[0] + (startDirection[0] / startMagnitude) * extensionDistance,
            startPoint[1] + (startDirection[1] / startMagnitude) * extensionDistance,
          ]
        : startPoint;

    const endPoint = originalCoords[originalCoords.length - 1];
    const secondLastPoint = originalCoords[originalCoords.length - 2];
    const endDirection = [endPoint[0] - secondLastPoint[0], endPoint[1] - secondLastPoint[1]];
    const endMagnitude = Math.sqrt(endDirection[0] ** 2 + endDirection[1] ** 2);

    const extendedEndPoint =
      endMagnitude > 0
        ? [
            endPoint[0] + (endDirection[0] / endMagnitude) * extensionDistance,
            endPoint[1] + (endDirection[1] / endMagnitude) * extensionDistance,
          ]
        : endPoint;

    const extendedCoords = [extendedStartPoint, ...originalCoords.slice(1, -1), extendedEndPoint];
    const extendedGeometry = new LineString(extendedCoords);
    const extendedFeature = new Feature(extendedGeometry);

    if (splitLineFeature.getProperties()) {
      extendedFeature.setProperties(splitLineFeature.getProperties());
    }

    return extendedFeature;
  }
  /**
   * Alternative method: Extend line to guarantee intersection with polygon boundary
   * This method extends the line until it's guaranteed to cross the polygon completely
   */
  private extendSplitLineToGuaranteeIntersection(
    splitLineFeature: Feature<LineString>,
    polygonGeometry: Polygon,
  ): Feature<LineString> {
    const olUserDrawnLine = splitLineFeature.getGeometry() as LineString;
    const originalCoords = olUserDrawnLine.getCoordinates();

    if (originalCoords.length < 2) {
      return splitLineFeature;
    }

    // Get polygon extent for boundary calculations
    const [minX, minY, maxX, maxY] = polygonGeometry.getExtent();

    // Calculate maximum possible distance needed (diagonal of polygon's bounding box + buffer)
    const maxDistance = Math.sqrt(Math.pow(maxX - minX, 2) + Math.pow(maxY - minY, 2)) * 1.5; // 150% of diagonal to guarantee coverage

    const startPoint = originalCoords[0];
    const endPoint = originalCoords[originalCoords.length - 1];
    const secondPoint = originalCoords.length > 1 ? originalCoords[1] : endPoint;
    const secondLastPoint =
      originalCoords.length > 1 ? originalCoords[originalCoords.length - 2] : startPoint;

    // Extend start point
    const startDirection = [startPoint[0] - secondPoint[0], startPoint[1] - secondPoint[1]];
    const startMagnitude = Math.sqrt(startDirection[0] ** 2 + startDirection[1] ** 2);
    const extendedStart =
      startMagnitude > 0
        ? [
            startPoint[0] + (startDirection[0] / startMagnitude) * maxDistance,
            startPoint[1] + (startDirection[1] / startMagnitude) * maxDistance,
          ]
        : startPoint;

    // Extend end point
    const endDirection = [endPoint[0] - secondLastPoint[0], endPoint[1] - secondLastPoint[1]];
    const endMagnitude = Math.sqrt(endDirection[0] ** 2 + endDirection[1] ** 2);
    const extendedEnd =
      endMagnitude > 0
        ? [
            endPoint[0] + (endDirection[0] / endMagnitude) * maxDistance,
            endPoint[1] + (endDirection[1] / endMagnitude) * maxDistance,
          ]
        : endPoint;

    // Create extended coordinate array
    const extendedCoords = [extendedStart, ...originalCoords, extendedEnd];

    const extendedGeometry = new LineString(extendedCoords);
    const extendedFeature = new Feature(extendedGeometry);

    if (splitLineFeature.getProperties()) {
      extendedFeature.setProperties(splitLineFeature.getProperties());
    }

    console.log(
      `Line extended to guarantee intersection: ${originalCoords.length} -> ${extendedCoords.length} points`,
    );

    return extendedFeature;
  }

  // In your component
  getFeatureSource(feature: Feature<Geometry>): VectorSource | null {
    if (!this.drawService.mapInstance) return null;

    // Find which layer contains this feature
    const layers = this.drawService.mapInstance.getLayers().getArray();
    for (const layer of layers) {
      if (layer instanceof VectorLayer) {
        const source = layer.getSource();
        if (source && source.hasFeature(feature)) {
          return source;
        }
      }
    }
    return null;
  }

  private async processSplitResults(
    originalFeature: Feature<Polygon>,
    splitResult: { poly1: Coordinate[][]; poly2: Coordinate[][] }, // These coordinates are in EPSG:4326 from the split service
  ): Promise<void> {
    console.log('[Split] Starting to process split results...');
    const targetLayerId = this.layerService.getSelectedCurrentLayerIdForDrawing();
    if (targetLayerId === null) {
      throw new Error('Processing failed: No target layer selected for split results.');
    }

    // --- Define our known projections ---
    const DATA_PROJECTION = 'EPSG:4326'; // The projection of the data from the split service.
    const MAP_PROJECTION = 'EPSG:3857'; // The projection required for display on the map.

    // 1. Create new OL features from the split result coordinates.
    //    The helper function will transform them from WGS84 to Web Mercator for display.
    let newFeature1: Feature<Polygon>, newFeature2: Feature<Polygon>;
    try {
      [newFeature1, newFeature2] = this.createOlSplitFeaturesFromCoords(
        originalFeature,
        splitResult.poly1,
        splitResult.poly2,
        targetLayerId,
        DATA_PROJECTION, // Source projection of the coordinates
        MAP_PROJECTION, // Destination projection for the map
      );
    } catch (e: any) {
      console.error('[Split] Error creating new OL features from split result:', e);
      // Re-throw the error to be caught by the main splitPolygon function's catch block
      throw new Error(`Failed to create valid split geometry: ${e.message}`);
    }

    // 2. Prepare all data needed for staging the operation.
    //    The FeatureService's converters will handle the final transformation to WGS84 for the backend.
    const originalUuid = originalFeature.get('uuid'); // Always use UUID string (not numeric feature_Id)
    const gnd_id = originalFeature.get('gnd_Id') || null;
    const originalFeatureData = this.featureService.convertFeatureToFeatureData(originalFeature);
    // Set parent_uuid as an array on split pieces so the backend's isinstance(list) check passes
    // and the original polygon gets soft-deleted (status=False) on save.
    newFeature1.set('parent_uuid', originalUuid ? [originalUuid] : null);
    newFeature2.set('parent_uuid', originalUuid ? [originalUuid] : null);
    const newFeatureData1 = this.featureService.convertFeatureToFeatureData(
      newFeature1,
      null,
      gnd_id,
    );
    const newFeatureData2 = this.featureService.convertFeatureToFeatureData(
      newFeature2,
      null,
      gnd_id,
    );

    if (!originalFeatureData || !newFeatureData1 || !newFeatureData2) {
      throw new Error(
        'Failed to convert features to data format for staging. Check console for details.',
      );
    }

    // 3. Stage the entire operation as a single "split" event.
    //    This is cleaner for undo/redo and saving.
    this.featureService.stageSplit([newFeatureData1, newFeatureData2], originalFeatureData);
    console.log(
      `[Split] Staged 'split' operation for original feature ${originalFeature.get('uuid')}.`,
    );

    // 4. Update the map UI (Optimistic Update).
    //    This happens *after* all data preparation is confirmed to be successful.
    const source = this.getFeatureSource(originalFeature);
    if (source) {
      source.removeFeature(originalFeature);
      source.addFeatures([newFeature1, newFeature2]);
      console.log('[Split] Map UI has been updated with the new split features.');
    } else {
      // This is a more critical error, as it means the UI can't be updated.
      console.error(`Could not find the map source for the original feature to update the UI.`);
      this.notifications.showError('Critical error: Could not update the map with split results.');
    }
  }

  // Helper to create OL Features from coordinate arrays (adapted from DrawService)
  // In tools.component.ts

  // Helper to create OL Features from coordinate arrays
  // in tools.component.ts

  private createOlSplitFeaturesFromCoords(
    originalFeature: Feature<Polygon>,
    coords1: Position[][], // WGS84 coordinates from Turf
    coords2: Position[][], // WGS-84 coordinates from Turf
    targetLayerId: number | string,
    sourceProj: ProjectionLike, // This will be 'EPSG:4236'
    destProj: ProjectionLike, // This will be the map's projection, 'EPSG:3857'
  ): [Feature<Polygon>, Feature<Polygon>] {
    // 1. Get properties from the original feature that should be inherited.
    const originalProps = originalFeature.getProperties();
    const parentUuid = originalProps['uuid'];
    const parentGndId = originalProps['gnd_Id'] ?? originalProps['gnd_id'] ?? null; // Inherit the GND ID

    // 🔁 Internal helper function to build each new polygon feature
    const createNewFeature = (coords: Position[][], part: number): Feature<Polygon> => {
      // A. Ensure the coordinate ring is properly closed (robustness fix)
      const outerRing = coords[0];
      if (outerRing.length > 2) {
        const firstPos = outerRing[0];
        const lastPos = outerRing[outerRing.length - 1];
        if (firstPos[0] !== lastPos[0] || firstPos[1] !== lastPos[1]) {
          outerRing.push(firstPos);
        }
      } else {
        throw new Error(
          `Invalid geometry for split part ${part}. A polygon must have at least 4 points.`,
        );
      }

      // B. Create the OL geometry and transform it for map display
      const geometry = new Polygon(coords).transform(sourceProj, destProj);

      if (!geometry.getCoordinates() || geometry.getCoordinates()[0].length < 4) {
        throw new Error(`Geometry for part ${part} became invalid after projection.`);
      }

      // C. Create the new OL Feature and set its properties
      const newFeature = new Feature(geometry);
      const newUuid = uuidv4();

      const area = this.geomService.getArea(newFeature);

      newFeature.setProperties({
        area: parseFloat(area.toFixed(4)),
        user_id: Number(this.userService.getUser()?.user_id) || 0,
        layer_id: targetLayerId,
        feature_Id: newUuid,
        uuid: newUuid,
        parent_uuid: parentUuid ? [parentUuid] : null,
        gnd_Id: parentGndId, // <<< THE KEY CHANGE: Inherit from parent
        length: 0,
        ref_id: this.drawService.selectedRefFeatureId, // Inherit ref_id if any
      });

      // D. Set OL-specific attributes (ID for lookup and style for display)
      newFeature.setId(`${targetLayerId}-${newUuid}`);
      const color = this.layerService.getLayerColor(targetLayerId as number);
      newFeature.setStyle(this.drawService.createStyleForLayer(color, 'Polygon'));

      console.log(`[Split] Successfully created new OL Feature ${newUuid} for part ${part}.`);
      return newFeature;
    };

    return [createNewFeature(coords1, 1), createNewFeature(coords2, 2)];
  }

  triggerDeleteSelected(): void {
    if (
      this.drawService._activeTool.value?.type !== 'select' ||
      this.drawService._selectedFeatures.value.length === 0
    ) {
      this.notifications.showInfo('Use the Select tool to select features before deleting.');
      return;
    }
    this.drawService.deleteFeatures(); // DrawService handles the rest
  }

  saveAllChanges(): void {
    if (this.isSaving) return;
    this.isSaving = true;

    const stagedCount = this.featureService.getStagedChangesCount();
    const progress$ = new Subject<ProgressUpdate>();

    const dialogRef =
      stagedCount > 50
        ? this.dialog.open<ProgressDialogComponent, ProgressDialogData>(ProgressDialogComponent, {
            width: '420px',
            disableClose: true,
            data: {
              title: `Saving ${stagedCount} Change${stagedCount !== 1 ? 's' : ''}`,
              progress$: progress$.asObservable(),
            },
          })
        : null;

    if (dialogRef) {
      progress$.next({ done: 0, total: stagedCount, label: 'Preparing data...' });
    }

    this.featureService
      .saveStagedChanges(
        stagedCount > 50
          ? (done, total, label) => {
              progress$.next({ done, total, label });
              this.cdr.markForCheck();
            }
          : undefined,
      )
      .subscribe({
        next: () => {
          this.cdr.markForCheck();
        },
        error: (err: any) => {
          console.error('[ToolsComponent] Save failed.', err);
          this.isSaving = false;
          dialogRef?.close();
          progress$.complete();
        },
        complete: () => {
          this.isSaving = false;
          if (dialogRef) {
            progress$.next({ done: stagedCount, total: stagedCount, label: 'Done!' });
            setTimeout(() => {
              dialogRef.close();
              progress$.complete();
            }, 600);
          }
        },
      });
  }

  activateDistanceMeasure(): void {
    if (this.activeUtilityTool === 'distance') {
      this.cleanupUtilityInteractions();
      return;
    }
    this.startMeasureDraw('distance');
  }

  activateAngleMeasure(): void {
    if (this.activeUtilityTool === 'angle') {
      this.cleanupUtilityInteractions();
      return;
    }
    this.startMeasureDraw('angle');
  }

  toggleGeoTagMenu(): void {
    if (this.activeUtilityTool === 'geotag') {
      this.cleanupUtilityInteractions();
      this.showGeoTagMenu = false;
      this.notifications.showInfo('GeoTag mode deactivated.');
      return;
    }
    this.showGeoTagMenu = !this.showGeoTagMenu;
    this.geoTagContextMenu.visible = false;
  }

  selectGeoTagType(tag: GeoTagType): void {
    this.cleanupUtilityInteractions();
    this.activeUtilityTool = 'geotag';
    this.selectedGeoTagType = tag;
    this.showGeoTagMenu = false;
    this.drawService.setActiveTool(null);
    this.notifications.showInfo(`Click the map to place: ${tag.label}`);

    const map = this.mapService.getMapInstance();
    this.mapClickKey = map.on('singleclick', (evt) => {
      if (!this.selectedGeoTagType) return;
      const lonLat = transform(evt.coordinate, 'EPSG:3857', 'EPSG:4326');
      this.apiService
        .createGeoTag({
          tag_type: this.selectedGeoTagType.type,
          label: this.selectedGeoTagType.label,
          longitude: lonLat[0],
          latitude: lonLat[1],
        })
        .subscribe({
          next: (tagRow) => {
            this.addGeoTagFeature(tagRow);
            this.notifications.showSuccess(`${tagRow.label} tag placed.`);
          },
          error: (err) =>
            this.notifications.showError(err?.error?.error || 'Could not save GeoTag.'),
        });
    });
  }

  setGeoTagStatus(active: boolean): void {
    const feature = this.geoTagContextMenu.feature;
    const tagId = feature?.get('tagId');
    // Close the context menu right away so it doesn't linger during the request.
    this.geoTagContextMenu.visible = false;
    if (!feature || !tagId) return;
    this.apiService.updateGeoTag(tagId, { status: active }).subscribe({
      next: (row) => {
        feature.set('status', row.status);
        feature.setStyle(this.geoTagStyle(feature));
      },
      error: (err) => this.notifications.showError(err?.error?.error || 'Could not update GeoTag.'),
    });
  }

  deleteGeoTag(): void {
    const feature = this.geoTagContextMenu.feature;
    const tagId = feature?.get('tagId');
    // Close the context menu right away so it doesn't linger during the request.
    this.geoTagContextMenu.visible = false;
    if (!feature || !tagId) return;
    this.apiService.deleteGeoTag(tagId).subscribe({
      next: () => {
        this.geoTagLayer?.getSource()?.removeFeature(feature);
      },
      error: (err) => this.notifications.showError(err?.error?.error || 'Could not delete GeoTag.'),
    });
  }

  private startMeasureDraw(kind: 'distance' | 'angle'): void {
    this.cleanupUtilityInteractions();
    this.ensureUtilityLayers();
    this.drawService.setActiveTool(null);
    this.activeUtilityTool = kind;

    const map = this.mapService.getMapInstance();
    const source = this.measureLayer?.getSource();
    if (!source) return;

    this.activeDraw = new Draw({
      source,
      type: 'LineString',
      maxPoints: kind === 'angle' ? 3 : undefined,
      style: this.measureStyle(''),
    });
    map.addInteraction(this.activeDraw);
    this.notifications.showInfo(
      kind === 'distance'
        ? 'Draw a temporary line to measure distance.'
        : 'Click three points to measure the angle.',
    );
    this.activeDraw.on('drawend', (event: DrawEvent) => {
      const line = event.feature.getGeometry() as LineString;
      const label = kind === 'distance' ? this.distanceLabel(line) : this.angleLabel(line);
      event.feature.set('measureLabel', label);
      event.feature.setStyle(this.measureStyle(label));
      this.cleanupUtilityInteractions(false);
    });
  }

  private ensureUtilityLayers(): void {
    const map = this.mapService.getMapInstance();
    if (!this.measureLayer) {
      this.measureLayer = new VectorLayer({
        source: new VectorSource(),
        zIndex: 9998,
      });
      map.addLayer(this.measureLayer);
    }
    if (!this.geoTagLayer) {
      this.geoTagLayer = new VectorLayer({
        source: new VectorSource<Feature<Point>>(),
        zIndex: 9999,
      });
      map.addLayer(this.geoTagLayer);
    }
  }

  private loadGeoTags(): void {
    this.ensureUtilityLayers();
    const source = this.geoTagLayer?.getSource();
    if (!source) return;
    source.clear();
    this.apiService.getGeoTags().subscribe({
      next: (tags) => tags.forEach((tag) => this.addGeoTagFeature(tag)),
      error: (err) => console.warn('Could not load GeoTags.', err),
    });
  }

  private addGeoTagFeature(tag: any): void {
    this.ensureUtilityLayers();
    if (tag.longitude == null || tag.latitude == null) return;
    const coordinate = transform([tag.longitude, tag.latitude], 'EPSG:4326', 'EPSG:3857');
    const feature = new Feature(new Point(coordinate));
    feature.setProperties({
      tagId: tag.id,
      tagType: tag.tag_type,
      label: tag.label,
      status: tag.status,
      note: tag.note,
      isGeoTag: true,
    });
    feature.setStyle(this.geoTagStyle(feature));
    this.geoTagLayer?.getSource()?.addFeature(feature);
  }

  private installGeoTagContextMenu(): void {
    if (this.contextMenuHandler) return;
    const map = this.mapService.getMapInstance();
    this.contextMenuHandler = (evt: MouseEvent) => {
      const pixel = map.getEventPixel(evt);
      const feature = map.forEachFeatureAtPixel(pixel, (candidate) => {
        return candidate.get('isGeoTag') ? candidate : null;
      }) as Feature<Point> | null;
      if (!feature) return;
      evt.preventDefault();
      evt.stopPropagation();
      this.geoTagContextMenu = {
        visible: true,
        x: evt.clientX,
        y: evt.clientY,
        feature,
      };
      this.cdr.markForCheck();
    };
    map.getViewport().addEventListener('contextmenu', this.contextMenuHandler, true);
  }

  private cleanupUtilityInteractions(clearTool = true): void {
    const map = this.mapService.mapInstance;
    if (this.activeDraw && map) {
      map.removeInteraction(this.activeDraw);
    }
    if (this.mapClickKey) {
      unByKey(this.mapClickKey);
    }
    this.activeDraw = null;
    this.mapClickKey = null;
    if (clearTool) {
      this.activeUtilityTool = null;
      this.selectedGeoTagType = null;
    }
  }

  private distanceLabel(line: LineString): string {
    const meters = getLength(line, { projection: 'EPSG:3857' });
    return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters.toFixed(1)} m`;
  }

  private angleLabel(line: LineString): string {
    const coords = line.getCoordinates();
    if (coords.length < 3) return 'Angle: incomplete';
    const [a, b, c] = coords;
    const angle1 = Math.atan2(a[1] - b[1], a[0] - b[0]);
    const angle2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let deg = Math.abs(((angle2 - angle1) * 180) / Math.PI);
    if (deg > 180) deg = 360 - deg;
    return `${deg.toFixed(1)} deg`;
  }

  private measureStyle(label: string): Style[] {
    return [
      new Style({
        stroke: new Stroke({ color: '#2563eb', width: 3 }),
        image: new CircleStyle({
          radius: 5,
          fill: new Fill({ color: '#2563eb' }),
          stroke: new Stroke({ color: '#ffffff', width: 2 }),
        }),
      }),
      new Style({
        text: new Text({
          text: label,
          offsetY: -16,
          fill: new Fill({ color: '#111827' }),
          stroke: new Stroke({ color: '#ffffff', width: 4 }),
          font: '600 13px Arial',
        }),
      }),
    ];
  }

  private geoTagStyle(feature: Feature<Point>): Style {
    const active = feature.get('status') !== false;
    const label = feature.get('label') || 'Tag';
    const type = String(feature.get('tagType') || 'other');
    const color = this.geoTagColor(type, active);
    return new Style({
      image: new Icon({
        src: this.geoTagIconSrc(type, color),
        anchor: [0.5, 1],
        scale: 1,
      }),
      text: new Text({
        text: label,
        offsetY: -34,
        fill: new Fill({ color: '#111827' }),
        stroke: new Stroke({ color: '#ffffff', width: 4 }),
        font: '600 12px Arial',
      }),
    });
  }

  private geoTagColor(type: string, active: boolean): string {
    if (type === 'tree') return '#16a34a';
    if (type === 'other') return '#4f46e5';
    if (['road_damage', 'garbage', 'fire'].includes(type)) {
      return active ? '#dc2626' : '#16a34a';
    }
    return active ? '#dc2626' : '#16a34a';
  }

  private geoTagIconSrc(type: string, color: string): string {
    const symbol = this.geoTagSymbolSvg(type);
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="34" height="42" viewBox="0 0 34 42">
        <path d="M17 41s14-13.2 14-24A14 14 0 1 0 3 17c0 10.8 14 24 14 24z" fill="${color}" stroke="#fff" stroke-width="2"/>
        <circle cx="17" cy="17" r="10.5" fill="rgba(255,255,255,0.16)"/>
        ${symbol}
      </svg>
    `;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  private geoTagSymbolSvg(type: string): string {
    switch (type) {
      case 'tree':
        return '<path d="M17 7l-6 9h3l-4 6h5v5h4v-5h5l-4-6h3z" fill="#fff"/>';
      case 'garbage':
        return '<path d="M12 12h10l-1 14h-8z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="M10 10h14M14 8h6M15 15v8M19 15v8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M12 12l10 14" stroke="#fff" stroke-width="1.5" stroke-linecap="round" opacity=".85"/>';
      case 'fire':
        return '<path d="M17 27c4.3 0 7-3 7-7.2 0-3.6-2.4-5.8-4.5-8.6-.4 2.4-1.3 3.5-2.6 4.7.2-3.2-1.7-5.4-3.4-7.5.2 4.7-4 6.6-4 11.4C9.5 24 12.7 27 17 27z" fill="#fff"/><path d="M17 24c1.5 0 2.5-1 2.5-2.4 0-1.1-.7-1.9-1.7-3.1-.3 1-.8 1.6-1.5 2.2-.2-1.1-.7-1.9-1.3-2.6.1 1.9-1.2 2.8-1.2 4.2 0 1 1.1 1.7 3.2 1.7z" fill="rgba(255,255,255,0.45)"/>';
      case 'road_damage':
        return '<path d="M11 26l4-18h4l4 18M17 9l-2 5 3 3-3 4 2 5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
      case 'drainage':
        return '<path d="M10 12h14v11H10z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="M13 15v5M17 15v5M21 15v5M11 25c2 1.2 4 1.2 6 0s4-1.2 6 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>';
      case 'street_light':
        return '<path d="M13 9h8l-2 6h-4zM17 15v11M13 26h8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
      default:
        return '<path d="M17 9a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 4v5m0 4h.01" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>';
    }
  }

  toggleMenu(): void {
    this.isMenuOpen = !this.isMenuOpen;
  }

  toggleDragPan(): void {
    this.isPanActive = !this.isPanActive;
    // Implement actual pan activation/deactivation in MapService or DrawService if needed
    // For now, this just toggles the button's visual state.
    if (this.isPanActive) {
      this.drawService.setActiveTool(null); // Deactivate other tools
      this.mapService.getMapInstance()?.getView().setConstrainResolution(false); // Allow free pan
      this.notifications.showInfo('Pan mode active.');
      // If you have a specific OL Pan interaction, activate it here.
      // OL default is drag pan, so often no explicit activation is needed
      // unless you're switching from a Draw/Modify interaction.
    } else {
      this.notifications.showInfo('Pan mode deactivated.');
    }
  }

  saveFeatures(): void {
    this.toolbarActionService.triggerSaveAll();
  }

  undoFeature(): void {
    this.featureService.onUndo();
  }

  getChangesCount() {
    return this.featureService.getStagedChangesCount();
  }
}

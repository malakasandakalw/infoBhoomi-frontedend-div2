import { inject, Injectable } from '@angular/core';
import { Map as OLMap } from 'ol';
import View from 'ol/View';
import LayerGroup from 'ol/layer/Group';
import TileLayer from 'ol/layer/Tile';
import VectorLayer, { Options as VectorLayerOptions } from 'ol/layer/Vector'; // Import Options
import VectorSource from 'ol/source/Vector';
import proj4 from 'proj4';
import { BehaviorSubject, Subject } from 'rxjs';
import { NotificationService } from './notifications.service';
// Removed unused fromLonLat
import Feature from 'ol/Feature'; // <-- Import Feature
import { Coordinate } from 'ol/coordinate';
import { getCenter } from 'ol/extent';
import { Geometry, Point } from 'ol/geom';
import {
  fromLonLat,
  get as getProjection /*, transform - removed unused */,
  transform,
} from 'ol/proj';
import { register } from 'ol/proj/proj4';
import { XYZ } from 'ol/source';
import TileWMS from 'ol/source/TileWMS'; // <-- IMPORT TileWMS SOURCE
import { APIsService } from './api.service';
import { LayerService } from './layer.service';
import { makePerFeatureStyleFn } from './style-factory.service';
import GeoJSON from 'ol/format/GeoJSON';
import { Fill, Stroke, Style } from 'ol/style';
import { UserService } from './user.service';

export type BaseMapType = 'OSM' | 'BING' | 'SENTINEL' | 'NASA_MODIS' | 'NASA_LANDSAT' | 'NASA_WMS';

export const environment = {
  production: false,
  sentinelHubId: 'YOUR_SENTINEL_HUB_INSTANCE_ID',
  nasaToken:
    'eyJ0eXAiOiJKV1QiLCJvcmlnaW4iOiJFYXJ0aGRhdGEgTG9naW4iLCJzaWciOiJlZGxqd3RwdWJrZXlfb3BzIiwiYWxnIjoiUlMyNTYifQ.eyJ0eXBlIjoiVXNlciIsInVpZCI6Im5tbWlsaW5kYSIsImV4cCI6MTc1NzMyOTgxMSwiaWF0IjoxNzUyMTQ1ODExLCJpc3MiOiJodHRwczovL3Vycy5lYXJ0aGRhdGEubmFzYS5nb3YiLCJpZGVudGl0eV9wcm92aWRlciI6ImVkbF9vcHMiLCJhY3IiOiJlZGwiLCJhc3N1cmFuY2VfbGV2ZWwiOjN9.Uq66wow9dzUDeUobLzZMsZtFfNho_-M9WFwys0G3BAk_m2VCEnRy_NpCIG14IHG3hsCgl5jIIxTFJPK6FNq5RikDAhL4loIAuz9mEhQiUH7T6vssSd1gaoOrKj3mM5oSqE-Ela_0jw1J1TlF1je4tMyYFN4IplKEgVHD9TyeevOcJ7jesQU_J7ABXeJ3Rxm6mMK3VbZj-GrOljD4r_I-WZs6xYJr2rqC31Umqqm8Hiq_qIUCtn4qdwOCczW3SXQqsCRIUO6cDoHuerfkEl0M2ZDr8YQJuNqCI02KK01s_Elb9VoKKadqf-oPTbSUpKtE8dWmoM0Se31zartwZDUrFQ',
};

export type ProjectionCode =
  | 'EPSG:4326'
  | 'EPSG:5235'
  | 'EPSG:27700'
  | 'EPSG:28355'
  | 'EPSG:3857'
  | 'EPSG:32644';

// Projection configuration should be centralized
const PROJECTION_CONFIG: Record<
  ProjectionCode,
  {
    def: string;
    defaultCenter: Coordinate;
  }
> = {
  'EPSG:4326': {
    def: 'WGS84',
    defaultCenter: [81.058073, 6.990495], // api
  },
  'EPSG:5235': {
    def: '+proj=tmerc +lat_0=7.0 +lon_0=80.77 +k=0.9993 +x_0=500000 +y_0=500000 +ellps=GRS80 +datum=GDA94 +units=m +no_defs',
    defaultCenter: [500000, 500000],
  },
  'EPSG:27700': {
    def: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy1830 +datum=OSGB36 +units=m +no_defs',
    defaultCenter: [400000, 100000],
  },
  'EPSG:28355': {
    def: '+proj=utm +zone=55 +south +ellps=GRS80 +datum=GDA94 +units=m +no_defs',
    defaultCenter: [450000, 200000],
  },

  'EPSG:3857': {
    def: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs',
    defaultCenter: [8978131, 719700], // Web Mercator (X, Y) for Kandy test data (7.291°N, 80.634°E)
  },

  'EPSG:32644': {
    def: '+proj=utm +zone=44 +north +ellps=WGS84 +datum=WGS84 +units=m +no_defs',
    defaultCenter: [0, 0],
  },
};

// since the projectCode is a type it has all the inforamtion requred for a view to define it projection

@Injectable({ providedIn: 'root' })
export class MapService {
  private userService = inject(UserService);
  mapInstance: OLMap | null = null;
  // 1. HARDCODE the active projection. Use 'readonly' to enforce it.
  private readonly mapViewProjectionCode: ProjectionCode = 'EPSG:3857';

  // NEW: State for the coordinate DISPLAY projection
  private displayProjectionSubject = new BehaviorSubject<ProjectionCode>('EPSG:4326');
  readonly displayProjection$ = this.displayProjectionSubject.asObservable();

  // private vectorLayers: { [key: string]: VectorLayer<VectorSource<Feature<Geometry>>> } = {};
  private activeBaseMapSubject = new BehaviorSubject<BaseMapType>('OSM');
  readonly activeBaseMap$ = this.activeBaseMapSubject.asObservable();

  private sentinelWmsSource: TileWMS | null = null;
  // Use BehaviorSubject to track the mapInstance state
  private mapSubject = new BehaviorSubject<OLMap | null>(null);
  readonly mapInstance$ = this.mapSubject.asObservable(); // Expose as Observable

  /** Emits after updateAllFeatureIdsAfterSave so DrawService can re-emit selection info. */
  readonly selectionRefresh$ = new Subject<void>();
  private vectorLayers = new Map<string, VectorLayer<VectorSource<Feature<Geometry>>>>();

  private readonly SHOW_LABELS_STORAGE_KEY = 'showLabels';
  private _showLabels$ = new BehaviorSubject<boolean>(this.readShowLabelsFromStorage());
  public readonly showLabels$ = this._showLabels$.asObservable();

  private readonly SHOW_AREA_STORAGE_KEY = 'showArea';
  private _showArea$ = new BehaviorSubject<boolean>(this.readShowAreaFromStorage());
  public readonly showArea$ = this._showArea$.asObservable();

  get showLabels(): boolean {
    return this._showLabels$.value;
  }

  setShowLabels(next: boolean): void {
    if (next === this._showLabels$.value) return;
    this._showLabels$.next(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem(this.SHOW_LABELS_STORAGE_KEY, JSON.stringify(next));
    }
    this.getMapInstance?.()
      ?.getLayers()
      .forEach((l) => l.changed?.());
  }

  private readShowLabelsFromStorage(): boolean {
    if (typeof window === 'undefined') return false;
    const raw = localStorage.getItem(this.SHOW_LABELS_STORAGE_KEY);
    if (raw === null) return false;
    try {
      return JSON.parse(raw) === true;
    } catch {
      return raw === 'true';
    }
  }

  get showArea(): boolean {
    return this._showArea$.value;
  }
  setShowArea(next: boolean): void {
    if (next === this._showArea$.value) return;
    this._showArea$.next(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem(this.SHOW_AREA_STORAGE_KEY, JSON.stringify(next));
    }
    this.getMapInstance?.()
      ?.getLayers()
      .forEach((l) => l.changed?.());
  }
  private readShowAreaFromStorage(): boolean {
    if (typeof window === 'undefined') return false;
    const raw = localStorage.getItem(this.SHOW_AREA_STORAGE_KEY);
    if (raw === null) return false;
    try {
      return JSON.parse(raw) === true;
    } catch {
      return raw === 'true';
    }
  }

  constructor(
    private notificationService: NotificationService,
    private apiService: APIsService,
  ) {
    this.registerProjections();
    this._subscribeToBaseMapChanges();
  }

  initializeMap(container: HTMLElement): void {
    // Or Map | undefined
    console.log('[MapService] InitializeMap called. Received targetElement:', container);

    if (!container) {
      console.error('[MapService] Map container element is invalid.');
      this.notificationService.showError('Map initialization failed: Invalid container.');
      this.mapSubject.next(null); // Notify subscribers of failure
      return;
    }

    if (this.mapInstance) {
      console.warn('[MapService] Map already exists. Setting new target if different.');
      const currentTarget = this.mapInstance.getTargetElement();

      if (currentTarget !== container) {
        console.log('[MapService] Setting new map target.');
        this.mapInstance.setTarget(container);
        // Use setTimeout to allow DOM update
        setTimeout(() => this.mapInstance?.updateSize(), 0);
      } else {
        console.log('[MapService] Map target is already set to the provided container.');
        setTimeout(() => this.mapInstance?.updateSize(), 0);
      }

      // Ensure subscribers are notified (optional if using BehaviorSubject correctly)
      if (this.mapSubject.getValue() !== this.mapInstance) {
        this.mapSubject.next(this.mapInstance);
      }

      this.setProjectionFromAPI();
      // Return the existing map or void, depending on your function signature needs
      // return this.map; or just return;
      return; // Prevent creating a new map
    }
    // *** END GUARD ***

    console.log('[MapService] Creating new Map instance...');
    try {
      // Create a group for all base layers
      const baseLayersGroup = this._createBaseLayersGroup();

      this.mapInstance = new OLMap({
        target: container,
        controls: [], // Start with no default controls
        layers: [
          baseLayersGroup, //
        ],
        view: this.createView(this.mapViewProjectionCode), // This now correctly uses EPSG:3857
      });

      console.log('[MapService] Map instance created.');
      this.mapSubject.next(this.mapInstance);

      this.setProjectionFromAPI();

      // return this.map; // If signature requires Map return
    } catch (error: any) {
      console.error('[MapService] Error creating OpenLayers MapInstance:', error);
      this.notificationService.showError(
        `MapInstance initialization failed: ${error.message || error}`,
      );
      this.mapSubject.next(null);
      // throw error; // Rethrow if necessary
    }
  }

  getMapViewProjCode(): ProjectionCode {
    return this.mapViewProjectionCode;
  }

  // --- NEW METHODS FOR DISPLAY PROJECTION ---

  /**
   * Sets the projection used for displaying coordinates (e.g., in MousePosition).
   * This does NOT change the map's view.
   * @param code The new projection code for display.
   */
  setDisplayProjection(code: ProjectionCode): void {
    if (this.displayProjectionSubject.getValue() !== code) {
      console.log(`[MapService] Setting DISPLAY projection to: ${code}`);
      this.displayProjectionSubject.next(code);
    }
  }

  /**
   * Gets the current projection code used for coordinate display.
   */
  getCurrentDisplayProjection(): ProjectionCode {
    return this.displayProjectionSubject.getValue();
  }

  /**
   * Helper to get all available projection codes for UI dropdowns.
   */
  getAvailableProjectionCodes(): ProjectionCode[] {
    return Object.keys(PROJECTION_CONFIG) as ProjectionCode[];
  }

  /**
   * Creates a LayerGroup containing all the available base map layers.
   */
  private _createBaseLayersGroup(): LayerGroup {
    const activeBaseMapId = this.activeBaseMapSubject.getValue();

    // --- Layer 1: OpenStreetMap (live OSM tile server) ---
    const osmLayer = new TileLayer({
      source: new XYZ({
        url: 'https://{a-c}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attributions:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }),
      visible: activeBaseMapId === 'OSM',
    });
    osmLayer.set('baseMapId', 'OSM');

    // --- Layer 2: Sentinel Hub WMS ---
    this.sentinelWmsSource = new TileWMS({
      url: `https://services.sentinel-hub.com/ogc/wms/${environment.sentinelHubId}`,
      params: { LAYERS: 'TRUE_COLOR', TIME: '2023-01-01/2023-12-31', MAXCC: 20 },
      serverType: 'geoserver',
      crossOrigin: 'anonymous',
    });
    this.sentinelWmsSource.on('tileloaderror', (e) =>
      console.error('Sentinel tile load error:', e),
    );
    const sentinelLayer = new TileLayer({
      source: this.sentinelWmsSource,
      visible: activeBaseMapId === 'SENTINEL',
    });
    sentinelLayer.set('baseMapId', 'SENTINEL');

    // --- NASA Layers (using XYZ for simplicity as in original code) ---
    // const nasaTileLoadFunction = this._createAuthTileLoadFunction(environment.nasaToken);

    // --- Layer 3: NASA MODIS ---
    const nasaModisSource = new XYZ({
      url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2023-07-15/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
      attributions: '© NASA EOSDIS',
      maxZoom: 9,
    });
    // nasaModisSource.setTileLoadFunction(nasaTileLoadFunction);
    const nasaModisLayer = new TileLayer({
      source: nasaModisSource,
      visible: activeBaseMapId === 'NASA_MODIS',
    });
    nasaModisLayer.set('baseMapId', 'NASA_MODIS');

    // --- Layer 4: NASA Landsat ---
    const nasaLandsatSource = new XYZ({
      url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/LANDSAT_8_CorrectedReflectance_TrueColor/default/2023-07-15/GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpg',
      attributions: '© NASA EOSDIS Landsat',
      maxZoom: 12,
    });
    // nasaLandsatSource.setTileLoadFunction(nasaTileLoadFunction);
    const nasaLandsatLayer = new TileLayer({
      source: nasaLandsatSource,
      visible: activeBaseMapId === 'NASA_LANDSAT',
    });
    nasaLandsatLayer.set('baseMapId', 'NASA_LANDSAT');

    // Group all layers together
    const baseLayers = [osmLayer, sentinelLayer, nasaModisLayer, nasaLandsatLayer];
    return new LayerGroup({ layers: baseLayers });
  }

  /**
   * Listens for changes in the active base map and updates layer visibility accordingly.
   */
  private _subscribeToBaseMapChanges(): void {
    this.activeBaseMap$.subscribe((activeId) => {
      if (!this.mapInstance) return;

      this.mapInstance.getLayers().forEach((layerOrGroup) => {
        if (layerOrGroup instanceof LayerGroup) {
          // This assumes the first group is our base layer group
          layerOrGroup.getLayers().forEach((layer) => {
            const id = layer.get('baseMapId');
            if (id) {
              layer.setVisible(id === activeId);
            }
          });
        }
      });
    });
  }

  /**
   * Updates the parameters of the Sentinel Hub WMS layer.
   * @param newParams An object containing the WMS parameters to update (e.g., { LAYERS: 'NDVI', TIME: '2024-05-01' }).
   */
  updateSentinelLayer(newParams: { [key: string]: any }): void {
    if (!this.sentinelWmsSource) {
      console.warn('[MapService] Sentinel source is not initialized.');
      return;
    }

    // Get the current parameters
    const currentParams = this.sentinelWmsSource.getParams();

    // Merge new parameters with existing ones
    const updatedParams = { ...currentParams, ...newParams };

    // Update the source parameters. This will automatically trigger a refresh of the tiles.
    this.sentinelWmsSource.updateParams(updatedParams);

    console.log('[MapService] Sentinel layer parameters updated:', updatedParams);
    this.notificationService.showSuccess('Satellite imagery updated.');
  }

  /**
   * Sets the active base map layer.
   * @param type The type of base map to activate ('OSM', 'BING', or 'SENTINEL').
   */
  setBaseMap(type: BaseMapType): void {
    if (!this.mapInstance) {
      console.warn('[MapService] setBaseMap called before map was initialized.');
      return;
    }
    // CHANGED: Use the subject's value for the check
    if (this.activeBaseMapSubject.getValue() === type) {
      console.log(`[MapService] Base map is already set to ${type}.`);
      return;
    }

    console.log(`[MapService] Switching base map to ${type}`);

    // Find the base layer group
    const layers = this.mapInstance.getLayers().getArray();
    const baseLayerGroup = layers.find((l) => l.get('baseMapId') === undefined) as LayerGroup; // A simple way to find the group

    if (!baseLayerGroup || !(baseLayerGroup instanceof LayerGroup)) {
      console.error('[MapService] Could not find the base layer group.');
      return;
    }

    // Loop through the layers within the group and set visibility
    baseLayerGroup.getLayers().forEach((layer) => {
      const id = layer.get('baseMapId');
      if (id) {
        layer.setVisible(id === type);
      }
    });

    // IMPORTANT: After successfully changing the map, broadcast the new state.
    this.activeBaseMapSubject.next(type);
    this.notificationService.showSuccess(`Switched to ${type} map`);
  }

  /** Helper to get the current value synchronously if needed */
  public getActiveBaseMap(): BaseMapType {
    return this.activeBaseMapSubject.getValue();
  }

  setProjectionFromAPI() {
    const user = this.userService.getUser();

    if (user?.user_id) {
      const sriLankaLonLat: [number, number] = [80.7, 7.8];
      const sriLankaZoom = 7.5;
      this.mapInstance?.getView().setCenter(fromLonLat(sriLankaLonLat));
      this.mapInstance?.getView().setZoom(sriLankaZoom);

      this.apiService.getCurrentLocation().subscribe({
        next: (res: any) => {
          if (
            res &&
            res.features &&
            res.features.length > 0 &&
            res.features[0].geometry &&
            res.features[0].geometry.type === 'Point'
          ) {
            const coords = res.features[0].geometry.coordinates as [number, number];

            this.mapInstance?.getView().animate({
              center: fromLonLat(coords),
              zoom: 16,
              duration: 3000,
            });

            this.notificationService.showSuccess('Map Projection Set Successfully.');
          } else {
            this.notificationService.showError('Could not determine user location from API.');
          }
        },
        error: (err) => {
          console.warn('Could not fetch org location:', err?.status, err?.message);
        },
      });
    }
  }

  // Corrected Code
  setCenterFromLonLat(lonLat: [number, number], zoom: number = 16) {
    const view = this.getView();
    if (!view) return;

    // Correctly transform from Lon/Lat (EPSG:4326) to the view's active projection
    const center = transform(lonLat, 'EPSG:4326', this.mapViewProjectionCode);

    view.setCenter(center);
    view.setZoom(zoom);
  }
  getMap$() {
    return this.mapSubject.getValue();
  }

  disposeMap(): void {
    if (this.mapInstance) {
      console.log('[MapService] Disposing map...');
      // Remove all tracked vector layers from the OL map first
      this.vectorLayers.forEach((layer) => {
        try {
          this.mapInstance?.removeLayer(layer);
        } catch (e) {
          console.error('Error removing layer during dispose:', e);
        }
      });
      this.vectorLayers.clear(); // Clear internal tracking map

      this.mapInstance.setTarget(undefined);
      this.mapInstance.dispose();
      this.mapInstance = null;
      this.mapSubject.next(null); // Notify subscribers
      console.log('[MapService] MapInstance disposed.');
    }
  }

  // --- Vector Layer Management Methods ---

  /**
   * Adds a new VectorLayer to the map or returns an existing one by ID.
   * @param layerId A unique identifier for the layer.
   * @param options Optional OpenLayers VectorLayer options.
   * @returns The created or existing VectorLayer. Throws error if map not ready.
   */

  addVectorLayer(
    layerId: string,
    options?: VectorLayerOptions<VectorSource<Feature<Geometry>>>, // Use imported options type
  ): VectorLayer<VectorSource<Feature<Geometry>>> {
    const olMap = this.getMapInstance(); // Throws if map not ready

    if (this.vectorLayers.has(layerId)) {
      console.warn(
        `[MapService] Layer with ID '${layerId}' already exists. Returning existing layer.`,
      );
      return this.vectorLayers.get(layerId)!;
    }

    console.log(`[MapService] Creating and adding VectorLayer with ID: ${layerId}`);
    const vectorSource = new VectorSource<Feature<Geometry>>(); // Explicitly type source
    const vectorLayer = new VectorLayer<VectorSource<Feature<Geometry>>>({
      // Ensure source is always provided, merge with user options
      source: vectorSource,
      ...options, // Spread any additional layer options provided by the caller
    });

    this.vectorLayers.set(layerId, vectorLayer);
    olMap.addLayer(vectorLayer); // Add layer to the actual map instance

    return vectorLayer;
  }

  getMapInstance(): OLMap {
    // Return type uses the alias
    if (!this.mapInstance) {
      throw new Error('Map is not initialized.');
    }
    return this.mapInstance;
  }

  /**
   * Gets a VectorLayer instance by its ID.
   * @param layerId The unique identifier of the layer.
   * @returns The VectorLayer or undefined if not found.
   */
  getVectorLayerById(layerId: string): VectorLayer<VectorSource<Feature<Geometry>>> | undefined {
    return this.vectorLayers.get(layerId);
  }

  findLayerByNumericId(
    numericLayerId: number | string,
  ): VectorLayer<VectorSource<Feature<Geometry>>> | null {
    if (!this.mapInstance) {
      console.warn('MapService findLayerByNumericId: Map not initialized.');
      return null;
    }
    const layerIdAsString = String(numericLayerId); // OL layer property is string
    const layers = this.mapInstance.getLayers().getArray();

    for (const layer of layers) {
      if (layer instanceof VectorLayer) {
        if (layer.get('layerId') === layerIdAsString) {
          // Compare with the string property
          return layer as VectorLayer<VectorSource<Feature<Geometry>>>;
        }
      }
    }
    console.warn(
      `MapService findLayerByNumericId: VectorLayer with custom ID string '${layerIdAsString}' not found.`,
    );
    return null;
  }
  // ...

  /**
   * Gets the VectorSource of a layer by its ID. Useful for feature manipulation.
   * @param layerId The unique identifier of the layer.
   * @returns The VectorSource or undefined if the layer or source is not found.
   */
  getVectorSourceById(layerId: string): VectorSource<Feature<Geometry>> | undefined {
    const layer = this.getVectorLayerById(layerId);
    // Use optional chaining and nullish coalescing for safety
    return layer?.getSource() ?? undefined;
  }

  /**
   * Removes a VectorLayer from the map and internal tracking.
   * @param layerId The unique identifier of the layer.
   */
  removeVectorLayerById(layerId: string): void {
    const layer = this.vectorLayers.get(layerId);
    if (layer) {
      console.log(`[MapService] Removing VectorLayer with ID: ${layerId}`);
      try {
        this.getMapInstance().removeLayer(layer); // Throws if map not ready
        this.vectorLayers.delete(layerId);
      } catch (error) {
        console.error(`[MapService] Error removing layer ${layerId}:`, error);
        // Optionally re-throw or notify
      }
    } else {
      console.warn(`[MapService] Layer with ID '${layerId}' not found for removal.`);
    }
  }

  setProjection(projection: ProjectionCode): void {
    // Check active code *before* getting the map Instance instance if possible
    if (projection === this.mapViewProjectionCode && this.mapInstance?.getView()) {
      console.log(`[MapService] Projection is already ${projection}. No change needed.`);
      return;
    }

    console.log(`[MapService] Setting projection to: ${projection}`);

    try {
      const newView = this.createView(projection);

      // Only update the view if the map actually exists
      if (this.mapInstance) {
        this.mapInstance.setView(newView);
      } else {
        console.warn('[MapService] MapInstance not initialized yet. View will be set on init.');
      }

      // Update the desired projection code regardless of map state
      // this.activeProjectionCode = projection;
    } catch (error) {
      this.notificationService.showError(`Failed to set projection to ${projection}`);
      console.error(`[MapService] Error setting projection to ${projection}:`, error);
    }
  }

  getView() {
    // Use optional chaining
    return this.mapInstance?.getView();
  }

  getCurrentProjCode(): ProjectionCode {
    return this.mapViewProjectionCode;
  }

  private registerProjections(): void {
    console.log('[MapService] Registering custom projections...');
    (
      Object.entries(PROJECTION_CONFIG) as [
        ProjectionCode,
        { def: string; defaultCenter: Coordinate },
      ][]
    ).forEach(([code, config]) => {
      if (code !== 'EPSG:4326' && !getProjection(code)) {
        try {
          console.log(`[MapService] Defining proj4 for ${code}`);
          proj4.defs(code, config.def);
        } catch (e) {
          console.error(`[MapService] Failed to define proj4 for ${code}:`, e);
        }
      } else {
        // Log appropriately
      }
    });

    try {
      console.log('[MapService] Registering proj4 with OpenLayers...');
      register(proj4);
      console.log('[MapService] proj4 registered with OpenLayers.');
    } catch (e) {
      console.error(`[MapService] Failed to register proj4 with OpenLayers:`, e);
    }
  }

  private createView(projectionCode: ProjectionCode): View {
    const projConfig = PROJECTION_CONFIG[projectionCode];
    if (!projConfig) {
      // Fallback or throw error if config is missing (shouldn't happen with TypeScript types)
      console.error(
        `[MapService] Missing projection configuration for ${projectionCode}. Falling back to ${this.mapViewProjectionCode}`,
      );
      return this.createView(this.mapViewProjectionCode);
    }
    // Ensure the projection is actually known to OL before creating the view
    if (!getProjection(projectionCode)) {
      console.error(
        `[MapService] Projection ${projectionCode} not registered or known to OpenLayers. Cannot create view.`,
      );
      // Potentially throw an error or use a default/fallback projection's view
      throw new Error(`Projection ${projectionCode} is not available.`);
    }

    return new View({
      projection: projectionCode,
      center: projConfig.defaultCenter, // Center should be in the coordinates of the VIEW projection
      zoom: 17,
      // Add extent if needed based on projection config
      // extent: getProjection(projectionCode)?.getExtent()
    });
  }

  setLayerZIndex(layerId: string | number, zIndex: number): void {
    const layer = this.vectorLayers.get(String(layerId));
    if (layer) {
      layer.setZIndex(zIndex);
      console.log(`Set zIndex of layer ${layerId} to ${zIndex}`);
    } else {
      console.warn(`Layer with ID ${layerId} not found when setting zIndex.`);
    }
  }

  normalizeToHex(color: string): string {
    if (!color || typeof color !== 'string') return '#000000';
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      if (ctx) {
        ctx.fillStyle = color;
        const parsed = ctx.fillStyle;
        const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(parsed);
        if (m) {
          const [r, g, b] = m.slice(1).map((n) => Number(n));
          const toHex = (n: number) => n.toString(16).padStart(2, '0');
          return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        }
        return parsed;
      }
    } catch {}
    return '#000000';
  }
  /**
   * Updates 'feature_Id' property for all features in all vector layers in the map,
   * matching by UUID.
   * @param savedRecords The 'saved_records' array from the backend response.
   */
  public updateAllFeatureIdsAfterSave(savedRecords: any[], layerService: LayerService): void {
    if (!this.mapInstance) {
      console.error('[DrawService] Map instance not available.');
      return;
    }

    // Build a UUID→record lookup map once — O(n) instead of rescanning per layer
    const recordByUuid = new Map<string, any>();
    for (const record of savedRecords) {
      if (record?.properties?.uuid) {
        recordByUuid.set(record.properties.uuid, record);
      }
    }
    console.log(
      '[updateAllFeatureIdsAfterSave] recordByUuid keys:',
      Array.from(recordByUuid.keys()),
    );
    if (recordByUuid.size === 0) return;

    const styleFn = makePerFeatureStyleFn(
      () => this.showLabels,
      () => this.showArea,
    );

    const layers = this.mapInstance
      .getLayers()
      .getArray()
      .filter((l) => l instanceof VectorLayer) as VectorLayer<any>[];

    console.log('[updateAllFeatureIdsAfterSave] VectorLayers found:', layers.length);

    // Single pass through layers × features — O(layers × features)
    let updatedCount = 0;
    for (const layer of layers) {
      const source = layer.getSource();
      if (!source) continue;

      for (const feature of source.getFeatures()) {
        // Match on the feature's uuid. Fall back to feature_Id because freshly
        // imported features carry the temporary uuid under BOTH 'uuid' and
        // 'feature_Id' — if either holds the staged uuid we can reconcile it.
        const uuid = (feature as any).get('uuid');
        const stagedFeatureId = (feature as any).get('feature_Id');
        const record =
          (uuid && recordByUuid.get(uuid)) ||
          (typeof stagedFeatureId === 'string' && recordByUuid.get(stagedFeatureId));
        if (!record) continue;

        const { su_id, gnd_id, calculated_area, layer_id, ref_id } = record.properties;
        feature.set('layer_id', layer_id);
        feature.set('feature_Id', su_id);
        feature.set('gnd_id', gnd_id);
        feature.set('area', calculated_area);
        feature.set('ref_id', ref_id ?? null);
        feature.set('ref_ids', ref_id ?? null);
        // Give the feature the same integer OL id it would have after a server
        // reload, so selection / lookups that read getId() resolve immediately
        // (this is what previously required a manual page refresh).
        if (su_id != null) {
          feature.setId(su_id);
        }
        const layerColor = layerService.getLayerColor(layer_id) ?? '#2c7be5';
        feature.set('baseHex', this.normalizeToHex(layerColor));
        feature.setStyle(styleFn);
        feature.changed();
        updatedCount++;
        console.log(
          '[updateAllFeatureIdsAfterSave] Updated feature:',
          uuid || stagedFeatureId,
          '→ su_id:',
          su_id,
        );
      }
    }
    console.log('[updateAllFeatureIdsAfterSave] Total features updated:', updatedCount);
    // Signal DrawService to re-emit selection info so the side panel
    // refreshes with the new integer su_id without requiring a re-click.
    this.selectionRefresh$.next();
  }

  public updateFeatureAfterUpdateOnlySave(savedRecord: any, layerService: LayerService): void {
    if (!this.mapInstance || !savedRecord?.properties) return;

    const { uuid, su_id, gnd_id, area, layer_id, ref_id } = savedRecord.properties;

    const layers = this.mapInstance
      .getLayers()
      .getArray()
      .filter((l) => l instanceof VectorLayer) as VectorLayer<any>[];

    const styleFn = makePerFeatureStyleFn(
      () => this.showLabels,
      () => this.showArea,
    );

    for (const layer of layers) {
      const source = layer.getSource();
      if (!source) continue;

      const feature = source.getFeatures().find((f: any) => f.get('uuid') === uuid);
      if (!feature) continue;

      feature.set('layer_id', layer_id);
      feature.set('feature_Id', su_id);
      feature.set('gnd_id', gnd_id);
      feature.set('area', area);
      feature.set('ref_id', ref_id ?? null);
      feature.set('ref_ids', ref_id ?? null);

      const layerColor = layerService.getLayerColor(layer_id) ?? '#2c7be5';
      feature.set('baseHex', this.normalizeToHex(layerColor));
      feature.setStyle(styleFn);
      feature.changed();
      break;
    }
  }

  private readonly QUERY_HIGHLIGHT_ID = 'query-highlight';

  private readonly highlightStyle = new Style({
    fill: new Fill({ color: 'rgba(255, 215, 0, 0.45)' }),
    stroke: new Stroke({ color: '#FF4500', width: 3 }),
  });

  /**
   * Adds returned query features as a highlight overlay on the map and zooms to them.
   * @param features Array of {su_id, layer_id, area_m2, geojson} from /query-parcels/
   */
  highlightQueryResults(features: { su_id: number; geojson: any }[]): void {
    this.clearQueryHighlight();
    const validFeatures = features.filter((f) => f.geojson != null);
    if (!validFeatures.length) return;

    const featureCollection = {
      type: 'FeatureCollection',
      features: validFeatures.map((f) => ({
        type: 'Feature',
        id: f.su_id,
        geometry: f.geojson,
        properties: { su_id: f.su_id },
      })),
    };

    const layer = this.addVectorLayer(this.QUERY_HIGHLIGHT_ID, {
      style: this.highlightStyle,
      zIndex: 999,
    });

    const olFeatures = new GeoJSON().readFeatures(featureCollection, {
      dataProjection: 'EPSG:4326',
      featureProjection: this.mapViewProjectionCode,
    });

    layer.getSource()!.addFeatures(olFeatures);

    const extent = layer.getSource()!.getExtent();
    if (extent && extent.every((v) => isFinite(v))) {
      this.mapInstance?.getView().fit(extent, {
        padding: [60, 60, 60, 60],
        maxZoom: 18,
        duration: 800,
      });
    }
  }

  /** Removes the query highlight overlay layer from the map. */
  clearQueryHighlight(): void {
    if (this.vectorLayers.has(this.QUERY_HIGHLIGHT_ID)) {
      this.removeVectorLayerById(this.QUERY_HIGHLIGHT_ID);
    }
  }

  zoomToFeatureBySuId(
    suId: string,
    opts: { zoom?: number; durationMs?: number; fitToExtent?: boolean } = {},
  ): Feature<Geometry> | null {
    const map = this.getMapInstance();
    const zoom = opts.zoom ?? 18;
    const duration = opts.durationMs ?? 600;
    const fitToExtent = opts.fitToExtent === true;

    const layers = map
      .getLayers()
      .getArray()
      .filter((l) => (l as any).getSource?.()?.getFeatures) as any[];

    for (const layer of layers) {
      const src = layer.getSource();
      const feature = src?.getFeatures()?.find((f: Feature) => {
        const a = f.get('feature_Id');
        const b = f.get('su_id');
        return String(a ?? b) === String(suId);
      });

      console.log(feature);

      if (!feature) continue;

      const geom = feature.getGeometry();
      if (!geom) continue;

      if (fitToExtent && geom.getType() !== 'Point') {
        map.getView().fit(geom.getExtent(), {
          duration,
          padding: [32, 32, 32, 32],
          maxZoom: zoom,
        });
      } else {
        const center =
          geom.getType() === 'Point'
            ? (geom as Point).getCoordinates()
            : getCenter(geom.getExtent());

        map.getView().animate({ center, zoom, duration });
      }
      return feature;
    }
    return null;
  }
}

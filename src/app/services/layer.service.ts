import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Map as OLMap } from 'ol';
import Feature from 'ol/Feature';
import GeoJSON from 'ol/format/GeoJSON';
import { Geometry } from 'ol/geom';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style';
import { BehaviorSubject, Observable, Subject, catchError, throwError } from 'rxjs';
import { startWith, tap } from 'rxjs/operators'; // Added tap
import { environment } from '../../../environments/environment'; // Adjust path if needed
import {
  API_LAYER_GEOM_RESPONSE,
  API_LAYER_RESPONSE,
  AddLayerModel,
  PasswordVerificationRequest,
  UpdateLayerModel,
  VERIFICATION_RESPONSE,
} from '../models/API';
import { MapService } from './map.service';
import { UserService } from './user.service';

import { forkJoin, of } from 'rxjs';
import { finalize, switchMap } from 'rxjs/operators';

// Models and other services
import { APIsService } from './api.service'; // <-- IMPORT for GND data
import { makePerFeatureStyleFn } from './style-factory.service';

// OpenLayers imports

@Injectable({
  providedIn: 'root',
})
export class LayerService {
  private userService = inject(UserService);
  public mapInstance: OLMap | null = null;
  private apiUrl = environment.API_URL; // Use the environment variable for the API URL
  // layerIdChanged = new ReplaySubject<number | null>(1); // Change to ReplaySubject(1)
  // layerNames: { [key: number]: string } = {};

  private get userId(): number {
    const user = this.userService.getUser();
    const user_id = user?.user_id;
    return Number(user_id) || 0;
  }
  // Dependencies
  private http = inject(HttpClient);
  private mapService = inject(MapService);
  private destroyRef = inject(DestroyRef);
  private apiService = inject(APIsService); // <-- INJECT

  // --- Private State ---
  private geoJsonFormatter = new GeoJSON();
  private layerCache = new Map<number, API_LAYER_RESPONSE>(); // Keyed by NUMERIC layer_id

  // --- Public State Observables ---
  // For UI to show a loading spinner
  private isLoadingSubject = new BehaviorSubject<boolean>(false);
  public isLoading$ = this.isLoadingSubject.asObservable();
  // Buildings are disabled for plain 'user' role; admin / super_admin can edit.
  // Resolved in constructor once userService is available.
  private buildingsDisabledSubject = new BehaviorSubject<boolean>(true);
  public buildingsDisabled$ = this.buildingsDisabledSubject.asObservable();

  // For UI to display the list of all available layers (e.g., in side-panel)
  private allLayersSubject = new BehaviorSubject<API_LAYER_RESPONSE[]>([]);
  public allLayers$ = this.allLayersSubject.asObservable();

  // For controlling layer visibility on the map
  public selectedLayerIdsSubject = new BehaviorSubject<(number | string | null)[]>([]); // Default visible layer
  public selectedLayerIds$ = this.selectedLayerIdsSubject.asObservable();

  // For identifying which layer is active for drawing
  private currentLayerIdForDrawingSubject = new BehaviorSubject<number | null | string>(null);
  public currentLayerIdForDrawing$ = this.currentLayerIdForDrawingSubject.asObservable();

  // Drawing Layer State (Holds single NUMERIC ID or null)
  private currentActiveLayerSubject = new BehaviorSubject<number | string | null>(null);
  public currentActiveLayer$ = this.currentActiveLayerSubject.asObservable();

  private openAdditionalLayerModal = false;

  setOpenAdditionalLayerModal(value: boolean): void {
    this.openAdditionalLayerModal = value;
  }

  getOpenAdditionalLayerModal(): boolean {
    return this.openAdditionalLayerModal;
  }

  // --- Cache for layer metadata (Use NUMERIC ID as key) ---
  getUserType(): string {
    const user = this.userService.getUser();
    return user?.user_type || '';
  }

  constructor() {
    // Reactively resolve buildings-disabled state from user role.
    // LayerService is constructed before user data is loaded from the token, so we
    // must subscribe to user$ and update whenever the user becomes available.
    this.userService.user$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((user) => {
      const role = user?.user_type || '';
      const isDisabled = role !== 'admin' && role !== 'super_admin';
      if (this.buildingsDisabledSubject.value !== isDisabled) {
        this.buildingsDisabledSubject.next(isDisabled);
      }
    });

    this.mapService.mapInstance$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((map) => {
      this.mapInstance = map;
    });

    this.mapService.showLabels$
      .pipe(startWith(this.mapService.showLabels), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.mapInstance?.getLayers().forEach((l) => l.changed?.());
      });
    this.mapService.showArea$
      .pipe(startWith(this.mapService.showArea), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.mapInstance?.getLayers().forEach((l) => l.changed?.());
      });
  }

  // =================================================================
  // MASTER LOADING METHOD
  // The component will call this single method to load everything.
  // =================================================================
  public loadInitialMapLayers(): void {
    if (this.isLoadingSubject.value) return; // Prevent concurrent loading
    console.log('LayerService: Starting initial layer load...');

    // Restore the previously selected drawing layer so the select/modify filter
    // keeps working across page reloads without the user having to re-open the layer panel.
    const savedLayerId =
      typeof window !== 'undefined' ? localStorage.getItem('selected_layer_id') : null;
    if (savedLayerId) {
      const parsed = parseInt(savedLayerId, 10);
      this.setSelectedCurrentLayerIdForDrawing(isNaN(parsed) ? savedLayerId : parsed);
      console.log(`LayerService: Restored active drawing layer from localStorage: ${savedLayerId}`);
    }
    // Defer to next tick to avoid NG0100 (ExpressionChangedAfterItHasBeenCheckedError)
    // when isLoading$ is read by an async pipe during Angular's current CD cycle.
    setTimeout(() => this.isLoadingSubject.next(true), 0);

    // Chain of operations:
    // 1. Get layer metadata.
    // 2. On success, load feature geometry and the GND boundary layer in parallel.
    this.getLayers()
      .pipe(
        switchMap((layers) => {
          if (layers.length > 0) {
            // Load geometry and GND layer concurrently
            return forkJoin({
              features: this._loadAllFeatureGeometry(),
              gnd: this._loadGndLayer(),
            });
          }
          console.warn('No layers found for this user.');
          return of(null); // Complete the stream
        }),
        finalize(() => {
          this.isLoadingSubject.next(false);
          console.log('LayerService: Initial layer load process finished.');
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: (err) => console.error('An error occurred during the layer loading chain:', err),
      });
  }

  // --- Core Data Fetching Methods (private or internal use) ---

  /** Fetches layer metadata, populates cache, and updates the allLayers$ subject. */
  public getLayers(): Observable<API_LAYER_RESPONSE[]> {
    const userType = this.getUserType() || '';
    let url: string;

    switch (userType) {
      case 'user':
      case 'admin':
      case 'super_admin':
        url = `${environment.API_URL}${'layerdata_get_admin/'}`; // Assuming admin endpoint covers all
        break;
      default:
        console.error('Unknown user type:', userType);
        return of([]); // Return empty observable for unknown types
    }

    return this.http.get<API_LAYER_RESPONSE[]>(url, { headers: this.getHeaders() }).pipe(
      tap((layers) => {
        this.layerCache.clear();
        layers.forEach((layer) => this.layerCache.set(layer.layer_id, layer));
        this.allLayersSubject.next(layers); // Emit for UI components
        console.log('LayerService: Layer metadata cache populated.', this.layerCache);
      }),
    );
  }

  /**
   * REFACTORED: Loads and processes all feature geometry for the cached layers.
   * This logic was moved from MainComponent.
   */
  private _loadAllFeatureGeometry(): Observable<any> {
    if (!this.mapInstance) return of(null);

    const layerIds = Array.from(this.layerCache.keys());
    if (layerIds.length === 0) {
      console.warn('No layer IDs in cache to load geometry for.');
      return of(null);
    }

    // 1. Create OpenLayers vector layers for each layer ID
    layerIds.forEach((layerId) => this._createOrUpdateOlLayer(layerId));

    // 2. Fetch geometry data from the backend
    const user = this.userService.getUser();
    const userId = Number(user?.user_id) || 0;
    const layerRequest = { user_id: userId };

    console.debug(
      '[LayerService] Requesting geometry — user_id:',
      userId,
      '| layer IDs:',
      layerIds,
    );

    return this.http
      .post<API_LAYER_GEOM_RESPONSE>(
        `${environment.API_URL}${'survey_rep_data_user/'}`,
        layerRequest,
        { headers: this.getHeaders() },
      )
      .pipe(
        tap((response) => {
          if (!response || !response.features) {
            console.error('[LayerService] Geometry endpoint returned a null/malformed response.', {
              sentUserId: userId,
              response,
            });
            return;
          }

          if (response.features.length === 0) {
            console.warn('[LayerService] Geometry endpoint returned 0 features.', {
              sentUserId: userId,
              cachedLayerIds: layerIds,
              hint: 'Check that survey_rep_data_user/ filters by user_id and that records exist for this user.',
            });
            return;
          }

          console.debug(
            '[LayerService] Received',
            response.features.length,
            'features from backend.',
          );
          // 3. Add features to their respective layers
          this._processAndAddFeatures(response.features);
        }),
        catchError((err) => {
          console.error('[LayerService] HTTP error loading feature geometry:', {
            sentUserId: userId,
            status: err?.status,
            message: err?.message,
            error: err,
          });
          return of(null);
        }),
      );
  }

  /** REFACTORED: Creates or clears an OpenLayers VectorLayer for a given ID. */
  private _createOrUpdateOlLayer(layerId: number): VectorLayer<VectorSource> {
    let olLayer = this._findLayerByNumericId(layerId);

    console.log(
      olLayer,
      '.....................................................................................................................................................................',
    );

    if (olLayer) {
      olLayer.getSource()?.clear();
    } else {
      const source = new VectorSource();
      olLayer = new VectorLayer({
        source,
        visible: this.selectedLayerIdsSubject.value.includes(layerId),
        zIndex: layerId,
      });
      olLayer.set('layerId', layerId.toString());
      this.mapInstance?.addLayer(olLayer);
    }
    return olLayer;
  }

  /** REFACTORED: Processes raw feature data and adds OL Features to the correct layer. */
  private _processAndAddFeatures(rawFeatures: any[]): void {
    console.log(`Processing ${rawFeatures.length} raw features...`);
    const layersWithFeatures = new Set<number>();
    for (const item of rawFeatures) {
      const layerId = item.properties?.layer_id;
      const olLayer = this._findLayerByNumericId(layerId);

      if (!olLayer) {
        console.warn(`Could not find OL layer for layer_id ${layerId}. Skipping feature.`);
        continue;
      }

      if (!item.geometry) {
        console.warn(`Feature ${item.id ?? item.properties?.uuid} has null geometry. Skipping.`);
        continue;
      }

      // console.log('item:::::::', item);

      const color = this.layerCache.get(layerId)?.colour || '#000000';
      const feature = this.createFeature(
        item.geometry.type,
        item.geometry.coordinates,
        color,
        item.properties?.uuid,
        item.id,
        item.properties?.calculated_area,
      );

      if (feature) {
        feature.set('layer_id', layerId); // Ensure layer_id is on the feature
        feature.set('gnd_Id', item.properties?.gnd_id || null); // Set the backend ID
        feature.set('ref_id', item.properties?.ref_id ?? null);
        feature.set('ref_ids', item.properties?.ref_id ?? null);
        if (item.properties?.su_id) {
          // su_id is the numeric spatial-unit ID the side panel and save logic need.
          // Store under both keys so getFeatureIdentifier('feature_Id') resolves correctly.
          feature.set('su_id', item.properties.su_id);
          feature.set('feature_Id', item.properties.su_id);
        } else {
          // su_id is null (trigger didn't run on this record) — use the model PK (id)
          // which is always non-null and is what the backend delete/get views use.
          feature.set('feature_Id', item.properties?.id ?? item.id);
        }
        olLayer.getSource()?.addFeature(feature);
        layersWithFeatures.add(layerId);
      }
    }
    // Preserve any existing string layer IDs (e.g. 'gnd_boundary_layer') already in the
    // subject so they are not evicted when numeric feature-layer IDs are written.
    const existingStringIds = this.selectedLayerIdsSubject.value.filter(
      (id) => typeof id === 'string',
    );
    this.selectedLayerIdsSubject.next([...existingStringIds, ...Array.from(layersWithFeatures)]);
    const map = this.mapService.getMapInstance?.();
    map?.getLayers().forEach((l) => l.changed?.());
    console.log('Finished processing and adding features to map.');
  }

  /**
   * REFACTORED: Loads the GND boundary layer.
   * This logic was moved from MainComponent.
   */
  private _loadGndLayer(): Observable<any> {
    if (!this.mapInstance) return of(null);

    const layerName = 'gnd_boundary_layer';

    // Remove any existing GND layer first
    const existingGndLayer = this.findLayerByName(layerName);
    if (existingGndLayer) {
      this.mapInstance.removeLayer(existingGndLayer);
    }

    return this.apiService.getGndData().pipe(
      tap((geoJsonData) => {
        if (!geoJsonData) return;

        const gndStyle = new Style({
          stroke: new Stroke({ color: '#3e4142e6', width: 1 }),
          fill: new Fill({ color: 'transparent' }),
        });

        const vectorSource = new VectorSource({
          features: this.geoJsonFormatter.readFeatures(geoJsonData, {
            featureProjection: this.mapInstance?.getView().getProjection(),
          }),
        });

        const gndLayer = new VectorLayer({
          source: vectorSource,
          style: gndStyle,
          visible: false, // GND boundary is OFF by default — user can enable it under Settings tab
          zIndex: 0,
        });
        gndLayer.set('layerId', layerName);

        this.mapInstance?.addLayer(gndLayer);

        // Do NOT register the GND layer as selected on load — it starts hidden.
        console.log('GND Layer added to the map successfully (hidden by default).');
      }),
      catchError((err) => {
        console.error('Error loading GND layer:', err);
        // Return of(null) to allow the forkJoin to complete even if this fails
        return of(null);
      }),
    );
  }

  /**
   * Finds a VectorLayer on the map by its string 'layerId' property.
   * This is a private helper for internal service use.
   * @param layerName The string identifier of the layer (e.g., 'gnd_boundary_layer').
   * @returns The VectorLayer instance or null if not found.
   */
  private findLayerByName(layerName: string): VectorLayer<VectorSource> | null {
    if (!this.mapInstance) {
      // console.warn('findLayerByName called but map instance is not available.');
      return null;
    }

    const foundLayer = this.mapInstance
      .getLayers()
      .getArray()
      .find((layer) => layer instanceof VectorLayer && layer.get('layerId') === layerName);

    // If a layer is found, it's returned; otherwise, `find` returns undefined, which becomes null.
    return (foundLayer as VectorLayer<VectorSource>) || null;
  }

  // --- Feature and Style Creation ---

  createFeature(
    geometryType: string,
    coordinates: any,
    color: string,
    uuid?: string,
    featureId?: number,
    area?: number,
  ): Feature<Geometry> | null {
    try {
      const geometry = this.geoJsonFormatter.readGeometry(
        { type: geometryType, coordinates },
        {
          dataProjection: 'EPSG:4326',
          featureProjection: this.mapInstance?.getView().getProjection() || 'EPSG:3857',
        },
      );
      if (!geometry) return null;

      const feature = new Feature({
        geometry,
        uuid,
        feature_Id: featureId,
        area,
      });

      const hexColor = this.convertColorNameToHex(color);
      feature.set('baseHex', hexColor);

      feature.setStyle(
        makePerFeatureStyleFn(
          () => this.mapService.showLabels,
          () => this.mapService.showArea,
        ),
      );

      return feature;
    } catch (error) {
      console.error(`Error creating feature ${geometryType}:`, error, coordinates);
      return null;
    }
  }

  // (getFeatureStyle and convertColorNameToHex methods remain the same)
  getFeatureStyle(geometryType: string, color: string): Style {
    const hexColor = this.convertColorNameToHex(color);
    const fillColor = `${hexColor}4D`; // 30% opacity

    switch (geometryType) {
      case 'Point':
        return new Style({
          image: new CircleStyle({
            radius: 5,
            fill: new Fill({ color: fillColor }),
            stroke: new Stroke({ color: hexColor, width: 1 }),
          }),
        });
      case 'LineString':
      case 'MultiLineString':
        return new Style({ stroke: new Stroke({ color: hexColor, width: 2 }) });
      case 'Polygon':
      case 'MultiPolygon':
        return new Style({
          fill: new Fill({ color: fillColor }),
          stroke: new Stroke({ color: hexColor, width: 1 }),
        });
      default:
        return new Style({
          stroke: new Stroke({ color: '#CCCCCC', width: 1 }),
          fill: new Fill({ color: 'rgba(204, 204, 204, 0.2)' }),
        });
    }
  }

  convertColorNameToHex(colorName: string): string {
    if (!colorName || typeof colorName !== 'string') return '#000000';
    if (colorName.startsWith('#') || colorName.startsWith('rgb')) return colorName;
    const normalizedColorName = colorName.replace(/\s+/g, '').toLowerCase();
    try {
      if (typeof document !== 'undefined') {
        const ctx = document.createElement('canvas').getContext('2d');
        if (ctx) {
          ctx.fillStyle = normalizedColorName;
          return ctx.fillStyle;
        }
      }
    } catch (e) {
      /* ignore */
    }
    return '#000000';
  }

  // --- Public State Modifiers ---

  public setLayerVisibility(layerId: number | string, isVisible: boolean): void {
    const currentIds = this.selectedLayerIdsSubject.value;
    const isCurrentlyVisible = currentIds.includes(layerId);
    let newIds = [...currentIds];

    if (isVisible && !isCurrentlyVisible) {
      newIds.push(layerId);
    } else if (!isVisible && isCurrentlyVisible) {
      newIds = currentIds.filter((id) => id !== layerId);
    } else {
      return; // No change needed
    }

    this.selectedLayerIdsSubject.next(newIds);
  }

  public setSelectedCurrentLayerIdForDrawing(layerId: number | null | string): void {
    if (this.currentLayerIdForDrawingSubject.value !== layerId) {
      this.currentLayerIdForDrawingSubject.next(layerId);
      // Ensure the drawing layer is visible so newly drawn features are immediately seen,
      // even if the layer has no existing backend features (which would otherwise leave it hidden).
      if (layerId !== null) {
        const currentIds = this.selectedLayerIdsSubject.value;
        if (!currentIds.includes(layerId)) {
          this.selectedLayerIdsSubject.next([...currentIds, layerId]);
        }
      }
    }
  }

  public async getLayerNameById(layerId: number): Promise<string | null> {
    if (this.layerCache.has(layerId)) {
      return this.layerCache.get(layerId)?.layer_name || null;
    }
    // If not in cache, fetch, then check again
    await this.getLayers().toPromise();
    return this.layerCache.get(layerId)?.layer_name || null;
  }

  public async getLayerNameOnlyById(layerId: number): Promise<string | null> {
    console.log('Layer cached', this.layerCache);
    if (this.layerCache.has(layerId)) {
      return this.layerCache.get(layerId)?.layer_name || null;
    }
    return this.layerCache.get(layerId)?.layer_name || null;
  }

  // --- Utility & Other Methods ---

  private getHeaders(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `token ${localStorage.getItem('Token') || ''}`,
      'Content-Type': 'application/json',
    });
  }

  getSelectedCurrentLayerIdForDrawing(): number | string | null {
    // Primarily return the in-memory state
    return this.currentLayerIdForDrawingSubject.value;
    // If initialization from localStorage is used, this will reflect it after service creation.
  }

  /**
   * Gets the VectorSource for the currently active drawing layer.
   * This is the primary method used by DrawService to know where to add new features.
   *
   * @returns The VectorSource of the active layer, or undefined if no layer is active
   *          or if the layer/source cannot be found.
   */
  public getDefaultSourceForInteractions(): VectorSource<Feature<Geometry>> | undefined {
    // 1. Get the active drawing layer ID from this service's state.
    const activeDrawingLayerId = this.getCurrentDrawingLayerId(); // Using our new, clear getter

    if (activeDrawingLayerId === null) {
      // This is a normal case when no drawing tool is active.
      // console.log('[LayerService] No active drawing layer set. Cannot provide a source.');
      return undefined;
    }

    // 2. Find the corresponding OpenLayers layer using our internal helper.
    const activeLayer = this._findLayerByNumericId(activeDrawingLayerId);

    if (!activeLayer) {
      console.warn(
        `[LayerService] Could not find an OL Layer on the map for active drawing layer ID: ${activeDrawingLayerId}.`,
      );
      return undefined;
    }

    // 3. Get the source from the found layer.
    // The _findLayerByNumericId helper already ensures it's a VectorLayer.
    const source = activeLayer.getSource();

    if (!source) {
      console.warn(
        `[LayerService] Active drawing layer ID ${activeDrawingLayerId} was found, but it has no source.`,
      );
      return undefined;
    }

    // 4. Success! Return the source.
    console.log(
      `[LayerService] Providing source from active drawing layer ID: ${activeDrawingLayerId}`,
    );
    return source;
  }

  // Renamed getter for clarity (as recommended previously)
  public getCurrentDrawingLayerId(): number | null | string {
    return this.currentLayerIdForDrawingSubject.value;
  }

  // The private helper this method now depends on
  private _findLayerByNumericId(layerId: number | null | string): VectorLayer<VectorSource> | null {
    if (!this.mapInstance) return null;
    const layerIdAsString = String(layerId);
    const foundLayer = this.mapInstance
      .getLayers()
      .getArray()
      .find((layer) => layer instanceof VectorLayer && layer.get('layerId') === layerIdAsString);
    return (foundLayer as VectorLayer<VectorSource>) || null;
  }

  /**
   * Retrieves the color for a specific layer ID from the cache.
   *
   * @param layerId The numeric ID of the layer.
   * @returns The color string (e.g., '#RRGGBB' or a color name) for the layer.
   *          Returns a default color ('#000000' - black) if the layer is not found.
   */
  public getLayerColor(layerId: number): string {
    // 1. Check if the layer metadata exists in the cache.
    if (this.layerCache.has(layerId)) {
      // 2. Retrieve the metadata object.
      const layerInfo = this.layerCache.get(layerId);

      // 3. Return the color from the object. Provide a default if the 'colour' property is missing.
      return layerInfo?.colour || '#000000';
    }

    // 4. If the layerId is not in the cache, log a warning and return a default color.
    console.warn(`[LayerService] Color not found for layer ID ${layerId}. Defaulting to black.`);
    return '#000000'; // Default to black to prevent errors
  }

  toggleLayerVisibility(layerId: number | string | null): void {
    const currentIds = this.selectedLayerIdsSubject.value;
    let newIds: (number | string | null)[];
    if (currentIds.includes(layerId)) {
      newIds = currentIds.filter((id) => id !== layerId);
      console.log(`LayerService: Removing layer ${layerId} from visible list.`);
    } else {
      newIds = [...currentIds, layerId];
      console.log(`LayerService: Adding layer ${layerId} to visible list.`);
    }
    console.log(`LayerService: Emitting new visible IDs:`, newIds);
    this.selectedLayerIdsSubject.next(newIds);
    // REMOVE MAP INTERACTION
  }

  /**
   * Sets the disabled state for building-related actions.
   * @param isDisabled `true` to disable, `false` to enable.
   */
  public setBuildingsDisabled(isDisabled: boolean): void {
    if (this.buildingsDisabledSubject.value !== isDisabled) {
      this.buildingsDisabledSubject.next(isDisabled);
    }
  }

  /**
   * Gets the current disabled state for building-related actions synchronously.
   * @returns `true` if disabled, `false` if enabled.
   */
  public getBuildingsDisabledState(): boolean {
    return this.buildingsDisabledSubject.value;
  }

  AddLayer(obj: AddLayerModel): Observable<API_LAYER_RESPONSE> {
    const url = `${environment.API_URL}${'layerdata/'}`;
    return this.http.post<API_LAYER_RESPONSE>(url, obj, { headers: this.getHeaders() });
  }

  UpdateLayer(obj: UpdateLayerModel, layerId: number): Observable<API_LAYER_RESPONSE> {
    const url = `${environment.API_URL}${'layerdata/'}${'update/id='}${layerId}/`;
    return this.http.patch<API_LAYER_RESPONSE>(url, obj, { headers: this.getHeaders() });
  }

  DeleteLayerData(layerId: number): Observable<any> {
    const url = `${environment.API_URL}${'layerdata/'}${'delete/id='}${layerId}/`;
    return this.http.delete(url, { headers: this.getHeaders() });
  }

  VerifyPassword(obj: PasswordVerificationRequest): Observable<VERIFICATION_RESPONSE> {
    const url = `${environment.API_URL}${'check-password/'}`;
    return this.http.post<VERIFICATION_RESPONSE>(url, obj, { headers: this.getHeaders() });
  }

  ngOnDestroy(): void {}
}

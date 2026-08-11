import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Feature } from 'ol';
import { Coordinate } from 'ol/coordinate';
import GeoJSON from 'ol/format/GeoJSON'; // Keep if used elsewhere, though helper avoids direct use here
import VectorSource from 'ol/source/Vector';
import { BehaviorSubject, concatMap, forkJoin, from, Observable, of, throwError } from 'rxjs';
import { catchError, map, tap, toArray } from 'rxjs/operators';
import { APIsService } from './api.service';
import { MapService } from './map.service';
import { NotificationService } from './notifications.service';
// Models & Utils
import { Geometry, LineString, MultiPolygon, Point, Polygon } from 'ol/geom'; // Import specific geometry types
import VectorLayer from 'ol/layer/Vector';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style';
import { v4 as uuidv4 } from 'uuid';
import { FeatureData, FeatureProperties, OLGeometry } from '../models/geometry';
import { AppStateService } from './app-state.service';
import { LayerService } from './layer.service';
import { SplitService } from './split.service';
import { UserService } from './user.service';

interface StagedAdd {
  type: 'add';
  newFeatureData: FeatureData;
  // Store the OL feature temporarily for potential undo on the map
  // Note: Holding OL Features in a service long-term can be problematic if map clears,
  // but necessary for this type of direct map undo.
  originalFeatureData: FeatureData | FeatureData[];
}
interface StagedUpdate {
  type: 'update';
  newFeatureData: FeatureData; // Contains the *updated* data
  originalFeatureData: FeatureData; // Optional: Store original state for complex undo
}
interface StagedDelete {
  type: 'delete';
  identifierToDelete: string; // Need UUID to tell backend which one to delete
  layerId: number; // Need layerId to potentially restore feature on map during undo
  originalFeatureData: FeatureData; // Optional: Store original data for undo restore
}

interface StageSplit {
  type: 'split';
  originalFeatureData: FeatureData;
  newFeaturesData?: [FeatureData, FeatureData]; // For 'split'
}

interface StagedMerge {
  type: 'merge';
  identifiersToMerge: string[]; // The backend IDs (UUIDs) of the features to be replaced
  newFeatureData: FeatureData; // The data for the single new feature to be created
  originalFeaturesData: FeatureData[]; // The full data of all original features, for a clean undo
}
type StagedChange = StagedAdd | StagedUpdate | StagedDelete | StageSplit | StagedMerge;

// ------------------------------

interface InfoPolygon {
  type: string;
  coordinates: Coordinate[][];
}

@Injectable({
  providedIn: 'root',
})
export class FeatureService {
  private userService = inject(UserService);
  private stagedChanges: StagedChange[] = [];
  private featureData: FeatureData[] = []; // Store all feature data here
  private vectorSource: VectorSource | undefined;
  private originalFeatures: FeatureData[] = [];
  private userToken = typeof window !== 'undefined' ? localStorage.getItem('Token') : null;
  private redoStack: StagedChange[] = [];

  private isSplitActive: boolean = false; // Track if split is active

  add: boolean = false;
  edit: boolean = false;
  delete: boolean = false;
  private _isSaving = new BehaviorSubject<boolean>(false);
  public readonly isSaving$ = this._isSaving.asObservable();

  get isSaving(): boolean {
    return this._isSaving.value;
  }

  constructor(
    private http: HttpClient,
    private apisService: APIsService,
    private notificationService: NotificationService,
    private appStateService: AppStateService, // Inject AppStateService
    private mapService: MapService,
    private splitService: SplitService, // Inject SplitService to access its methods
    private layerService: LayerService, // Inject LayerService to access its methods
  ) {
    // Optional: Initialize canUndo state based on initial stagedChanges (if any loaded from persistence)
    this.appStateService.setCanUndo(this.stagedChanges.length > 0);
    this.subscribeToSplitEvents();
  }

  setAddPermission = (value: boolean) => {
    this.add = value;
  };

  getAddPermission = (): boolean => {
    return this.add;
  };

  private POST_SURVEY_REP_DATA = this.apisService.POST_SURVEY_REP_DATA; // Use the API service to get the URL
  private DELETE_SURVEY_BATCH_DATA = this.apisService.DELETE_SURVEY_BATCH_DATA; // Use the API service to get the URL
  private UPDATE_SURVEY_REP_DATA = this.apisService.UPDATE_SURVEY_REP_DATA; // Use the API service to get the URL

  private subscribeToSplitEvents(): void {
    this.splitService.splitStatus$.subscribe({
      next: (splitStatus) => {
        if (splitStatus === true) {
          console.log('[FeatureService] Split detected. Performing undoSplit()...');
          this.isSplitActive = true;
        }
      },
      error: (err) => console.error('[FeatureService] splitStatus$ error:', err),
    });
  }

  private getAuthHeaders(): HttpHeaders {
    const currentToken = localStorage.getItem('Token'); // <-- GET IT FRESHLY HERE
    if (!currentToken) {
      // Optional: Handle the case where the token is missing at the time of the call
      console.error('[FeatureService] Auth token is missing. Cannot create auth headers.');
      // You might throw an error or return headers that will likely cause an auth error,
      // or handle this scenario more gracefully depending on your app's needs.
      // For now, let's proceed, and the backend will reject if auth is needed.
    }
    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      Authorization: `Token ${currentToken}`, // Use the freshly retrieved token
    });
    return headers;
  }

  /** Stages a feature to be added. Called by DrawService after processNewFeature adds to map. */
  stageAddition(
    newFeatureData: FeatureData,
    originalFeatureData: FeatureData | FeatureData[],
  ): void {
    this.clearRedoStack();
    if (!newFeatureData) return;
    console.log('[FeatureService] Staging ADD for UUID:', newFeatureData.properties.uuid);
    this.stagedChanges.push({ type: 'add', newFeatureData, originalFeatureData });
    this.appStateService.setCanUndo(true); // An undo is now possible
  }

  /** Stages multiple features for addition in one operation. Avoids per-feature console spam
   *  and redundant undo-state updates that make bulk imports slow. */
  stageBulkAddition(items: FeatureData[]): void {
    if (!items.length) return;
    this.clearRedoStack();
    for (const featureData of items) {
      this.stagedChanges.push({
        type: 'add',
        newFeatureData: featureData,
        originalFeatureData: featureData,
      });
    }
    this.appStateService.setCanUndo(true);
    console.log(`[FeatureService] Staged bulk ADD of ${items.length} features.`);
  }

  /** Stages a feature to be updated. Called by DrawService after processModifiedFeature modifies map feature. */
  stageUpdate(newFeatureData: FeatureData, originalFeatureData: FeatureData): void {
    this.clearRedoStack();
    if (!newFeatureData) return;
    const uuid = newFeatureData.properties.uuid;
    console.log('[FeatureService] Staging UPDATE for UUID:', uuid);
    // Avoid duplicate updates for the same feature? Replace existing staged update?
    const existingIndex = this.stagedChanges.findIndex(
      (c) => c.type === 'update' && c.newFeatureData.properties.uuid === uuid,
    );
    if (existingIndex > -1) {
      console.log(`[FeatureService] Replacing existing staged update for UUID: ${uuid}`);
      this.stagedChanges[existingIndex] = { type: 'update', newFeatureData, originalFeatureData };
    } else {
      // If it was staged for ADDITION previously, just update the data within the 'add' stage
      const existingAddIndex = this.stagedChanges.findIndex(
        (c) => c.type === 'add' && c.newFeatureData.properties.uuid === uuid,
      );
      if (existingAddIndex > -1) {
        console.log(`[FeatureService] Updating data for existing staged ADD for UUID: ${uuid}`);
        (this.stagedChanges[existingAddIndex] as StagedAdd).newFeatureData = newFeatureData;
      } else {
        // Otherwise, stage it as a new update
        console.log(`[FeatureService] Staging UPDATE for UUID: ${newFeatureData.properties.uuid}`);
        this.stagedChanges.push({ type: 'update', newFeatureData, originalFeatureData });
        this.appStateService.setCanUndo(true); // An undo is now possible
      }
    }
  }

  /** Stages a feature to be deleted. Called by DrawService after removing feature from map. */
  stageDeletion(uuid: string, layerId: number, originalFeatureData: FeatureData): void {
    this.clearRedoStack();
    if (!uuid || layerId === undefined || layerId === null) return;
    console.log('[FeatureService] Staging DELETE for UUID:', uuid);

    // Handle cases where the feature was added then deleted before saving:
    const existingAddIndex = this.stagedChanges.findIndex(
      (c) => c.type === 'add' && c.newFeatureData.properties.uuid === uuid,
    );
    if (existingAddIndex > -1) {
      console.log(
        `[FeatureService] Removing staged ADD for UUID ${uuid} because it was deleted before save.`,
      );
      this.stagedChanges.splice(existingAddIndex, 1); // Just remove the staged 'add'
      return; // Don't stage the delete
    }

    // Avoid duplicate deletes
    const existingIndex = this.stagedChanges.findIndex(
      (c) => c.type === 'delete' && c.identifierToDelete === uuid,
    );
    if (existingIndex > -1) {
      console.log(`[FeatureService] Delete already staged for UUID: ${uuid}`);
      return; // Already staged
    }
    console.log(`[FeatureService] Staging DELETE for UUID: ${uuid}`);
    this.stagedChanges.push({
      type: 'delete',
      identifierToDelete: uuid,
      layerId,
      originalFeatureData,
    });
    this.appStateService.setCanUndo(true); // An undo is now possible
  }

  /**
   * Stages a merge operation. This involves replacing multiple old features with a single new one.
   * @param idsToMerge The backend identifiers (UUIDs) of the features to be deleted.
   * @param newFeatureData The complete data for the new feature that will be created.
   * @param originalFeaturesData An array containing the full data of all the original features, for undo purposes.
   */
  public stageMerge(
    idsToMerge: string[],
    newFeatureData: FeatureData,
    originalFeaturesData: FeatureData[],
  ): void {
    this.clearRedoStack();
    if (!idsToMerge || idsToMerge.length < 2 || !newFeatureData) {
      console.error('[FeatureService] stageMerge called with invalid arguments.');
      return;
    }

    console.log(
      `[FeatureService] Staging MERGE. Replacing ${idsToMerge.length} features with one new feature.`,
    );

    // Handle edge case: if a feature being merged was just added, remove its 'add' operation.
    idsToMerge.forEach((id) => {
      const existingAddIndex = this.stagedChanges.findIndex(
        (c) => c.type === 'add' && c.newFeatureData.properties.uuid === id,
      );
      if (existingAddIndex > -1) {
        console.log(
          `[FeatureService] Removing staged 'add' for feature ${id} as it is now part of a merge.`,
        );
        this.stagedChanges.splice(existingAddIndex, 1);
      }
    });

    this.stagedChanges.push({
      type: 'merge',
      identifiersToMerge: idsToMerge,
      newFeatureData: newFeatureData,
      originalFeaturesData: originalFeaturesData,
    });

    this.appStateService.setCanUndo(true);
  }

  /**
   * Stages a split operation. This involves replacing one original feature
   * with two new feature pieces.
   * @param newFeaturesData An array containing the data for the two new split features.
   * @param originalFeatureData The complete data of the original feature that was split.
   */
  public stageSplit(
    newFeaturesData: [FeatureData, FeatureData],
    originalFeatureData: FeatureData,
  ): void {
    this.clearRedoStack();

    // 1. Validate the input
    if (!newFeaturesData || newFeaturesData.length !== 2 || !originalFeatureData) {
      console.error('[FeatureService] stageSplit called with invalid arguments.');
      return;
    }

    const originalUuid = originalFeatureData.properties.uuid;
    console.log(`[FeatureService] Staging SPLIT for original feature UUID: ${originalUuid}`);

    // 2. Handle edge case: If the feature being split was just added (and not saved),
    //    we should simply remove its 'add' operation from the stack instead of staging a split.
    //    The two new pieces will be staged as a fresh 'add' operation. This simplifies the save logic.
    const existingAddIndex = this.stagedChanges.findIndex(
      (c) => c.type === 'add' && c.newFeatureData.properties.uuid === originalUuid,
    );

    if (existingAddIndex > -1) {
      console.log(
        `[FeatureService] Original feature ${originalUuid} was a new, unsaved feature. Replacing its 'add' stage with two new 'add' stages.`,
      );
      // Remove the original 'add' operation
      this.stagedChanges.splice(existingAddIndex, 1);

      // Stage the two new pieces as simple additions
      this.stageAddition(newFeaturesData[0], originalFeatureData); // originalFeatureData for undo is not needed here
      this.stageAddition(newFeaturesData[1], originalFeatureData); // as the action is just adding new shapes

      // No need to continue with staging a 'split' operation.
      return;
    }

    // 3. Push the complete 'split' operation to the staged changes stack.
    this.stagedChanges.push({
      type: 'split',
      newFeaturesData: newFeaturesData,
      originalFeatureData: originalFeatureData,
    });

    this.appStateService.setCanUndo(true); // An undo is now possible
  }

  /** Gets the current list of staged changes (for debugging or potential save logic). */
  getStagedChanges(): StagedChange[] {
    return [...this.stagedChanges]; // Return a copy
  }

  /** Clears all staged changes (e.g., after successful save or cancellation). */
  clearStagedChanges(): void {
    console.log('[FeatureService] Clearing all staged changes.');
    this.stagedChanges = [];
    this.appStateService.setCanUndo(false);
  }

  /** Retrieves the last staged change for potential undo operation. */
  getLastStagedChange(): StagedChange | undefined {
    return this.stagedChanges.length > 0
      ? this.stagedChanges[this.stagedChanges.length - 1]
      : undefined;
  }

  /** Removes the last staged change (used by undo). */
  removeLastStagedChange(): StagedChange | undefined {
    if (this.stagedChanges.length > 0) {
      const lastChange = this.stagedChanges.pop();
      console.log('[FeatureService] Removed last staged change:', lastChange);
      this.appStateService.setCanUndo(this.stagedChanges.length > 0); // Update based on remaining changes
      return lastChange;
    }
    console.log('[FeatureService] No staged changes to remove.');
    this.appStateService.setCanUndo(false); // Ensure it's false if list is empty
    return undefined;
  }

  public getStagedChangesCount(): number {
    return this.stagedChanges.length;
  }

  // <<< NEW/MODIFIED: Add undoMerge and redoMerge private methods
  /**
   * Undoes a merge operation. This removes the single merged feature
   * and restores all the original individual features.
   */
  private undoMerge(change: StagedMerge): void {
    const layerId = change.newFeatureData.properties.layer_id;
    const source = this.findLayerOnMap(layerId!)?.getSource();
    if (!source) {
      console.error(`UndoMerge: Cannot find source for layer ${layerId}.`);
      return;
    }

    // 1. Remove the single new feature that was created by the merge
    const newFeatureUuid = change.newFeatureData.properties.uuid;
    const featureToRemoveId = `${layerId}-${newFeatureUuid}`;
    const featureToRemove = source.getFeatureById(featureToRemoveId);
    if (featureToRemove) {
      source.removeFeature(featureToRemove);
    }

    // 2. Restore all the original features
    change.originalFeaturesData.forEach((originalData) => {
      const featureToAdd = this.convertFeatureDataToOlFeature(originalData);
      if (featureToAdd) {
        source.addFeature(featureToAdd);
      }
    });
    this.notificationService.showSuccess('Merge undone.');
  }

  /**
   * Re-applies a merge operation. This removes all the original features
   * and adds back the single merged feature.
   */
  private redoMerge(change: StagedMerge): void {
    const layerId = change.newFeatureData.properties.layer_id;
    const source = this.findLayerOnMap(layerId!)?.getSource();
    if (!source) {
      console.error(`RedoMerge: Cannot find source for layer ${layerId}.`);
      return;
    }

    // 1. Remove all the original features that were restored during the undo
    change.originalFeaturesData.forEach((originalData) => {
      const originalUuid = originalData.properties.uuid;
      const featureToRemoveId = `${layerId}-${originalUuid}`;
      const featureToRemove = source.getFeatureById(featureToRemoveId);
      if (featureToRemove) {
        source.removeFeature(featureToRemove);
      }
    });

    // 2. Restore the single merged feature
    const featureToAdd = this.convertFeatureDataToOlFeature(change.newFeatureData);
    if (featureToAdd) {
      source.addFeature(featureToAdd);
    }
    this.notificationService.showSuccess('Merge redone.');
  }

  // --- Backend Communication (Called by Save Action) ---

  /**
   * Saves all staged changes (adds, updates, deletes) to the backend.
   * Ideally uses a single batch endpoint, otherwise makes separate calls.
   */
  saveStagedChanges(
    progressFn?: (done: number, total: number, label: string) => void,
  ): Observable<any> {
    const headers = this.getAuthHeaders();
    if (this.stagedChanges.length === 0) {
      this.clearStagedChanges();
      this.notificationService.showInfo('No changes to save.');
      return of({ success: true, message: 'No changes to save.' });
    }

    const _t0 = performance.now();
    const adds = this.stagedChanges.filter((c) => c.type === 'add');
    const updates = this.stagedChanges.filter((c) => c.type === 'update');
    const deletes = this.stagedChanges.filter((c) => c.type === 'delete');
    const splits = this.stagedChanges.filter((c) => c.type === 'split');
    const merges = this.stagedChanges.filter((c) => c.type === 'merge');

    console.log(
      `[SAVE⏱] ── Staged: adds=${adds.length} updates=${updates.length} deletes=${deletes.length} splits=${splits.length} merges=${merges.length}`,
    );

    this._isSaving.next(true);

    // --- Build other (non-add) requests ---
    const otherRequests: Observable<any>[] = [];

    // add-only-update PATCHes (isUpdateOnly flag)
    let payloadNew: FeatureData[] = [];
    if (adds.length) {
      payloadNew = adds
        .filter((a) => !a.newFeatureData?.properties?.isUpdateOnly)
        .map((a) => a.newFeatureData);

      const payloadUpdate: FeatureData[] = adds
        .filter((a) => !!a.newFeatureData?.properties?.isUpdateOnly)
        .map((a) => a.newFeatureData);

      for (const fd of payloadUpdate) {
        const featureId = fd.properties.feature_Id;
        if (featureId == null) {
          console.warn('[saveStagedChanges] Skipping PATCH: missing feature_Id/ref_id on', fd);
          continue;
        }
        otherRequests.push(
          this.http.patch(this.apisService.UPDATE_SURVEY_REP_DATA(featureId), fd, { headers }),
        );
      }
    }

    if (deletes.length) {
      const ids = deletes.map((d) => d.identifierToDelete);
      otherRequests.push(
        this.http.delete(this.apisService.DELETE_SURVEY_BATCH_DATA, { headers, body: { ids } }),
      );
    }

    if (splits.length) {
      const payload = splits.flatMap((s) => s.newFeaturesData ?? []);
      otherRequests.push(
        this.http.post(this.apisService.POST_SURVEY_REP_DATA, payload, { headers }),
      );
    }

    if (merges.length) {
      const payload = merges.map((m) => m.newFeatureData);
      otherRequests.push(
        this.http.post(this.apisService.POST_SURVEY_REP_DATA, payload, { headers }),
      );
    }

    for (const u of updates) {
      // 1. Grab the payload
      const payload = u.newFeatureData;

      // 2. SANITIZER: Convert string booleans back to actual booleans
      if (payload && payload.properties) {
        Object.keys(payload.properties).forEach((key) => {
          if (payload.properties[key] === 'true') payload.properties[key] = true;
          if (payload.properties[key] === 'false') payload.properties[key] = false;
        });
      }

      // 3. Send the clean payload
      otherRequests.push(
        this.http.patch(
          this.apisService.UPDATE_SURVEY_REP_DATA(payload.properties.feature_Id),
          payload,
          { headers },
        ),
      );
    }
    if (!payloadNew.length && !otherRequests.length) {
      this.clearStagedChanges();
      this.notificationService.showInfo('No server operations needed.');
      return of({ success: true, message: 'No server operations needed.' });
    }

    // --- Batch the large add payload into chunks of 500 (sequential) ---
    const BATCH_SIZE = 500;
    const addTotal = payloadNew.length;
    let addsDone = 0;
    const addBatches: FeatureData[][] = [];
    for (let i = 0; i < payloadNew.length; i += BATCH_SIZE) {
      addBatches.push(payloadNew.slice(i, i + BATCH_SIZE));
    }

    const addBatch$: Observable<any[]> = addBatches.length
      ? from(addBatches).pipe(
          concatMap((batch) =>
            this.http.post(this.apisService.POST_SURVEY_REP_DATA, batch, { headers }).pipe(
              tap(() => {
                addsDone += batch.length;
                progressFn?.(
                  addsDone,
                  addTotal,
                  `Uploading features... (${addsDone} / ${addTotal})`,
                );
              }),
            ),
          ),
          toArray(),
        )
      : of([] as any[]);

    const other$: Observable<any[]> = otherRequests.length
      ? forkJoin(otherRequests)
      : of([] as any[]);

    return forkJoin([addBatch$, other$]).pipe(
      map(([addResults, otherResults]) => [
        ...addResults,
        ...(Array.isArray(otherResults) ? otherResults : [otherResults]),
      ]),
      tap((allResults) => {
        const savedRecords: any[] = [];
        for (const r of allResults) {
          if (!r) continue;
          if (Array.isArray(r)) {
            for (const item of r) {
              if (item?.saved_records && Array.isArray(item.saved_records)) {
                savedRecords.push(...item.saved_records);
              }
            }
            continue;
          }
          if (r.saved_records && Array.isArray(r.saved_records)) {
            savedRecords.push(...r.saved_records);
          } else if (r.properties?.uuid) {
            this.mapService.updateFeatureAfterUpdateOnlySave(r, this.layerService);
          }
        }

        const allWarnings: string[] = [];
        for (const r of allResults) {
          if (r?.warnings && Array.isArray(r.warnings) && r.warnings.length > 0) {
            allWarnings.push(...r.warnings.map((w: any) => String(w.detail)));
          }
        }

        if (savedRecords.length) {
          this.mapService.updateAllFeatureIdsAfterSave(savedRecords, this.layerService);
        }

        this.clearStagedChanges();

        if (allWarnings.length > 0) {
          this.notificationService.showSuccess(
            `${savedRecords.length} feature(s) saved successfully.`,
          );
          this.notificationService.showWarning(
            `${allWarnings.length} feature(s) saved without GND assignment — they fall outside the known GND boundaries or your organisation's AOI.`,
            6000,
          );
        } else {
          this.notificationService.showSuccess('All changes saved successfully.');
        }
        this._isSaving.next(false);
      }),
      catchError((err) => {
        this._isSaving.next(false);
        console.error('[FeatureService] Error during batch save:', err);
        const errorMsg = this.getApiErrorMessage(err, 'Failed to save some or all changes.');
        this.notificationService.showError(errorMsg);
        return throwError(() => new Error(errorMsg));
      }),
    );
  }

  // saveStagedChanges(): Observable<any> {
  //   const headers = this.getAuthHeaders();

  //   if (this.stagedChanges.length === 0) {
  //     this.notificationService.showInfo('No changes to save.');
  //     return of({ success: true, message: 'No changes.' });
  //   }

  //   console.log(`[FeatureService] Attempting to save ${this.stagedChanges.length} staged change(s)...`);

  //   // --- Prepare batches for Add and Delete operations ---
  //   const featuresToAddBatch: FeatureData[] = [];
  //   const identifiersToDelete: (string | number)[] = [];
  //   const updateRequestObservables: Observable<any>[] = [];

  //   // Loop through staged changes and sort them into the correct batches
  //   this.stagedChanges.forEach((change) => {
  //     switch (change.type) {
  //       case 'add':
  //         featuresToAddBatch.push(change.newFeatureData);
  //         break;

  //       case 'update':
  //         const featureIdForUpdate = change.newFeatureData.properties.feature_Id;
  //         if (featureIdForUpdate) {
  //           const updateUrl = this.apisService.UPDATE_SURVEY_REP_DATA(featureIdForUpdate);
  //           updateRequestObservables.push(
  //             this.http.patch(updateUrl, change.newFeatureData, { headers })
  //           );
  //         } else {
  //           console.error("UPDATE StagedChange missing 'feature_Id'!", change);
  //         }
  //         break;

  //       case 'delete':
  //         identifiersToDelete.push(change.identifierToDelete);
  //         break;

  //       case 'split':
  //         // For a split, we delete the original and add the two new pieces.
  //         // identifiersToDelete.push(change.originalFeatureData.properties.feature_Id);
  //         featuresToAddBatch.push(...change.newFeaturesData!);
  //         break;

  //       case 'merge':
  //         // For a merge, we add the new feature and delete all the original ones.
  //         featuresToAddBatch.push(change.newFeatureData);

  //         break;
  //     }
  //   });

  //   // --- Create Observables for Batch Add and Delete Requests ---
  //   const addRequestObservables: Observable<any>[] = [];
  //   if (featuresToAddBatch.length > 0) {
  //     const addUrl = this.apisService.POST_SURVEY_REP_DATA;
  //     console.log(`[FeatureService] Creating BATCH ADD request for ${featuresToAddBatch.length} features.`);
  //     addRequestObservables.push(this.http.post(addUrl, featuresToAddBatch, { headers }));
  //   }

  //   const deleteRequestObservables: Observable<any>[] = [];
  //   if (identifiersToDelete.length > 0) {
  //     const deleteUrl = this.apisService.DELETE_SURVEY_BATCH_DATA;
  //     const deletePayload = { ids: identifiersToDelete };
  //     console.log(`[FeatureService] Creating BATCH DELETE request for ${identifiersToDelete.length} features.`);
  //     deleteRequestObservables.push(this.http.delete(deleteUrl, { headers, body: deletePayload }));
  //   }

  //   // --- Combine and Execute All Requests ---
  //   const allRequests = [
  //     ...addRequestObservables,
  //     ...updateRequestObservables,
  //     ...deleteRequestObservables,
  //   ];

  //   if (allRequests.length === 0) {
  //     console.log('[FeatureService] No actual server requests needed.');
  //     this.clearStagedChanges();
  //     return of({ success: true, message: 'No server operations needed.' });
  //   }

  //   console.log(`[FeatureService] Executing ${allRequests.length} total requests via forkJoin.`);

  //   return forkJoin(allRequests).pipe(
  //     tap((results) => {
  //       console.log('[FeatureService] All save operations completed successfully:', results);
  //       // Assuming the ADD request is first and returns saved_records
  //       const addResult = results[0];
  //       if (addResult && addResult.saved_records) {
  //         this.mapService.updateAllFeatureIdsAfterSave(addResult.saved_records);
  //       }
  //       this.clearStagedChanges();
  //       this.notificationService.showSuccess('All changes saved successfully.');
  //     }),
  //     catchError((err) => {
  //       console.error('[FeatureService] Error during forkJoin save operation:', err);
  //       const errorMsg = err.error?.detail || err.error?.message || 'Failed to save some or all changes.';
  //       this.notificationService.showError(errorMsg);
  //       return throwError(() => new Error(errorMsg));
  //     }),
  //   );
  // }
  // // --- End of saveStagedChanges method ---

  // --- If you have a "clear all staged changes" or "revert all" ---
  clearAllStagedChanges(): void {
    if (this.stagedChanges.length > 0) {
      this.stagedChanges = [];
      this.appStateService.setCanUndo(false);
      this.notificationService.showInfo('All pending changes have been discarded.');
    }
  }

  // --- Error Handling (Keep as is) ---
  // Make sure this error handler exists and is suitable
  private handleHttpError<T>(operation = 'operation', result?: T) {
    return (error: HttpErrorResponse): Observable<T> => {
      // ... (your existing error logging/notification logic) ...
      console.error(`[FeatureService] ${operation} failed:`, error);
      this.notificationService.showError(
        `Operation ${operation} failed. ${error.statusText || ''}`,
      );
      return throwError(() => error); // Re-throw
    };
  }

  // End Class FeatureService

  // --- Deprecated Methods ---
  // Remove methods related to the old local featureData array if they existed
  // Remove the old saveFeatures()

  // ***************** Some of The Old Code Below is Deprecated *****************

  setVectorSource(source: VectorSource | undefined) {
    this.vectorSource = source;
  }

  getFeatureData(): FeatureData[] {
    return this.featureData;
  }

  addFeatureData(feature: FeatureData | FeatureData[]) {
    if (Array.isArray(feature)) {
      this.featureData.push(...feature);
    } else {
      this.featureData.push(feature);
    }
  }

  storeOriginalFeature(feature: FeatureData) {
    this.originalFeatures.push(feature);
  }

  clearFeatureData() {
    this.featureData = [];
  }
  getFeatureSource(feature: Feature): VectorSource | undefined {
    return feature.get('source') as VectorSource | undefined;
  }

  public onUndo(): void {
    // 1. Get the last change from the main "undo" stack.
    const lastChange = this.stagedChanges.pop();

    // 2. Guard against an empty stack.
    if (!lastChange) {
      this.notificationService.showInfo('Nothing left to undo.');
      return;
    }

    // 3. Move the undone change to the "redo" stack so it can be re-applied.
    this.redoStack.push(lastChange);
    console.log(`[Undo] Moved change of type '${lastChange.type}' to redo stack.`);

    // 4. Dispatch the change to the correct handler based on its type.
    switch (lastChange.type) {
      case 'add':
        // To undo an 'add', we must remove the feature.
        this.undoAdd(lastChange);
        break;

      case 'delete':
        // To undo a 'delete', we must add the feature back.
        this.undoDelete(lastChange);
        break;

      case 'update':
        // To undo an 'update', we revert the feature to its original state.
        this.undoUpdates(lastChange);
        break;

      case 'split':
        // To undo a 'split', we remove the new pieces and restore the original.
        this.undoSplit(lastChange);
        break;
      case 'merge':
        this.undoMerge(lastChange);
        break;

      default:
        // This case should ideally never be hit if your types are correct.
        console.error('Undo failed: Unknown change type encountered.', lastChange);
        this.notificationService.showError('Cannot undo: Unknown action type.');
        // Since we can't process it, we should probably remove it from the redo stack
        // to avoid breaking the redo functionality.
        this.redoStack.pop();
        break;
    }

    // 5. Update the global application state for UI buttons.
    this.appStateService.setCanUndo(this.stagedChanges.length > 0);
    this.appStateService.setCanRedo(this.redoStack.length > 0);
  }

  /**
   * Reverts a feature modification. This is the method responsible for
   * managing the undo/redo stack.
   */
  undoUpdates(change: { newFeatureData: FeatureData; originalFeatureData: FeatureData }) {
    // 1. Get essential identifiers from the ORIGINAL data.
    const layerId = change.originalFeatureData.properties.layer_id;
    const uuid = change.originalFeatureData.properties.uuid;

    // 2. Find the correct layer source.
    const source = this.findLayerOnMap(layerId!)?.getSource();
    if (!source || layerId === undefined || !uuid) {
      console.warn(`UndoUpdate: Cannot find source for layer ${layerId} or UUID is missing.`);
      return;
    }

    // 3. Construct the EXACT composite ID to find the feature on the map.
    const featureIdToFind = `${layerId}-${uuid}`;

    // 4. Find and remove the CURRENT (modified) feature from the source.
    const currentFeature = source.getFeatureById(featureIdToFind);
    if (currentFeature) {
      source.removeFeature(currentFeature);
    } else {
      console.warn(`UndoUpdate: Could not find feature with ID "${featureIdToFind}" to remove.`);
    }

    // 5. Convert the ORIGINAL data back into a full OpenLayers Feature.
    //    Our corrected utility function handles setting the ID and projection.
    const originalFeature = this.convertFeatureDataToOlFeature(change.originalFeatureData);

    // 6. If the conversion was successful, add the restored feature to the source.
    if (originalFeature) {
      source.addFeature(originalFeature);
      console.log(
        `UndoUpdate complete: Restored original feature with ID ${originalFeature.getId()}`,
      );
      this.notificationService.showInfo('Update undone.');
    } else {
      this.notificationService.showError('Failed to restore the original feature.');
    }
  }

  private undoAdd(change: { newFeatureData: FeatureData }) {
    const fd = change.newFeatureData;

    if (!fd || !fd.properties) {
      console.warn('UndoAdd: missing newFeatureData or its properties.', change);
      return;
    }

    const layerId = fd.properties.layer_id;
    const uuid = fd.properties.uuid;

    if (layerId === undefined || !uuid) {
      console.warn('UndoAdd: layer_id or uuid missing on newFeatureData.properties.', fd);
      return;
    }

    const source = this.findLayerOnMap(layerId!)?.getSource();
    if (!source) {
      console.warn(`UndoAdd: Cannot find source for layer ${layerId}.`);
      return;
    }

    const featureIdToFind = `${layerId}-${uuid}`;
    const existingFeature = source.getFeatureById(featureIdToFind);

    if (existingFeature) {
      source.removeFeature(existingFeature);
      console.log(`UndoAdd: Removed feature with UUID: ${uuid}`);
    } else {
      console.warn(`UndoAdd: Feature with UUID ${uuid} not found in source.`);
    }
  }

  public findLayerOnMap(
    layerIdAsNumber: number | string,
  ): VectorLayer<VectorSource<Feature<Geometry>>> | null {
    // 1. Get the map instance directly from the service, every time.
    const map = this.mapService.getMap$();

    // 2. Guard against the map not being ready yet.
    if (!map) {
      console.warn('[FeatureService] findLayerOnMap called before map was initialized.');
      return null;
    }

    // 3. The rest of your logic remains the same.
    const layerIdAsString = String(layerIdAsNumber);
    const layers = map.getLayers().getArray();
    const foundLayer = layers.find(
      (layer) => layer instanceof VectorLayer && layer.get('layerId') === layerIdAsString,
    );
    return (foundLayer as VectorLayer<VectorSource<Feature<Geometry>>>) || null;
  }

  /**
   * Undoes a delete operation by re-adding the original feature to the map.
   * This function is called when processing an undo action for a 'delete' change.
   *
   * @param change An object containing the data of the feature that was deleted.
   */
  public undoDelete(change: { originalFeatureData: FeatureData }) {
    // 1. Get the complete data of the feature that was deleted.
    const deletedFeatureData = change.originalFeatureData;

    if (!deletedFeatureData || !deletedFeatureData.properties) {
      console.error('UndoDelete: Invalid or missing originalFeatureData in the change object.');
      return;
    }

    // 2. Extract necessary identifiers from the stored data.
    const layerId = deletedFeatureData.properties.layer_id;
    const uuid = deletedFeatureData.properties.uuid;

    // 3. Guard against missing or invalid identifiers.
    if (layerId === undefined || !uuid) {
      console.error(
        "UndoDelete failed: The deleted feature data is missing a 'layer_id' or 'uuid'.",
        deletedFeatureData,
      );
      this.notificationService.showError('Cannot undo delete: Corrupted data.');
      return;
    }

    // 4. Find the correct layer source on the map.
    const source = this.findLayerOnMap(layerId!)?.getSource();
    if (!source) {
      console.warn(`UndoDelete: Could not find a map source for layer ID ${layerId}.`);
      return;
    }

    // 5. (Optional but good practice) Check if a feature with this ID somehow already exists.
    // This prevents creating duplicate features if the undo logic is triggered incorrectly.
    const compositeId = `${layerId}-${uuid}`;
    if (source.getFeatureById(compositeId)) {
      console.warn(
        `UndoDelete: A feature with ID "${compositeId}" already exists on the map. Aborting undo to prevent duplicates.`,
      );
      this.notificationService.showWarning('Feature already exists on the map.');
      return;
    }

    // 6. Convert the stored data back into a full OpenLayers Feature.
    // This re-uses our robust converter, which correctly sets the composite ID, projection, and style.
    const featureToRestore = this.convertFeatureDataToOlFeature(deletedFeatureData);

    // 7. If the conversion was successful, add the feature back to the source.
    if (featureToRestore) {
      source.addFeature(featureToRestore);
      console.log(
        `UndoDelete: Successfully restored feature with ID ${featureToRestore.getId()} to layer ${layerId}.`,
      );
      this.notificationService.showSuccess('Deletion undone.');
    } else {
      // This would happen if convertFeatureDataToOlFeature returned null.
      console.error('UndoDelete: Failed to convert feature data back into a displayable feature.');
      this.notificationService.showError('Failed to restore the deleted feature.');
    }
  }

  /**
   * Main Redo Handler.
   * Pops the last change from the redo stack, moves it back to the undo stack,
   * and dispatches it to the appropriate specialized redo function to re-apply it.
   */
  public onRedo(): void {
    // 1. Get the last change from the redo stack.
    const changeToRedo = this.redoStack.pop();

    // 2. Guard against an empty stack.
    if (!changeToRedo) {
      this.notificationService.showInfo('Nothing left to redo.');
      return;
    }

    // 3. Move the change back to the main "undo" stack.
    this.stagedChanges.push(changeToRedo);
    console.log(`[Redo] Moved change of type '${changeToRedo.type}' back to undo stack.`);

    // 4. Dispatch to the correct handler to re-apply the change.
    switch (changeToRedo.type) {
      case 'add':
        this.redoAdd(changeToRedo);
        break;
      case 'delete':
        this.redoDelete(changeToRedo);
        break;
      case 'update':
        this.redoUpdate(changeToRedo);
        break;
      case 'split':
        this.redoSplit(changeToRedo);
        break;
      case 'merge':
        this.redoMerge(changeToRedo);
        break;
      default:
        console.error('Redo failed: Unknown change type encountered.', changeToRedo);
        // If we can't process it, remove it from the undo stack to prevent corruption.
        this.stagedChanges.pop();
        break;
    }

    // 5. Update the global application state for UI buttons.
    this.appStateService.setCanUndo(this.stagedChanges.length > 0);
    this.appStateService.setCanRedo(this.redoStack.length > 0);
  }

  /**
   * Re-applies an 'add' action. (Identical logic to undoDelete).
   */
  private redoAdd(change: StagedAdd): void {
    // Only handle 'add' types that have originalFeatureData
    let layerId: number | string | null;

    const originalFeatureData = change.originalFeatureData;
    if (Array.isArray(originalFeatureData)) {
      // If it's an array, use the first element or handle all
      layerId = originalFeatureData[0]?.properties?.layer_id ?? null;
    } else {
      // It's a single FeatureData
      layerId = originalFeatureData.properties.layer_id;
    }
    const source = this.findLayerOnMap(layerId!)?.getSource();

    if (!source) {
      console.error(`RedoAdd: Cannot find source for layer ${layerId}.`);
      return;
    }
    // 2. REMOVE THE ORIGINAL FEATURE(S) that were restored during the undo.
    if (originalFeatureData) {
      if (Array.isArray(originalFeatureData)) {
        // It was an array (from a merge). Loop and remove each one.
        console.log(`RedoAdd: Removing ${originalFeatureData.length} original features.`);
        originalFeatureData.forEach((originalData) => {
          const originalLayerId = originalData.properties.layer_id;
          const originalUuid = originalData.properties.uuid;
          if (originalLayerId !== undefined && originalUuid) {
            const featureIdToRemove = `${originalLayerId}-${originalUuid}`;
            const featureToRemove = source.getFeatureById(featureIdToRemove);
            if (featureToRemove) {
              source.removeFeature(featureToRemove);
            }
          }
        });
      } else {
        // It was a single feature (from a split or other op).
        console.log(`RedoAdd: Removing 1 original feature.`);
        const originalData = originalFeatureData;
        const originalLayerId = originalData.properties.layer_id;
        const originalUuid = originalData.properties.uuid;
        if (originalLayerId !== undefined && originalUuid) {
          const featureIdToRemove = `${originalLayerId}-${originalUuid}`;
          const featureToRemove = source.getFeatureById(featureIdToRemove);
          if (featureToRemove) {
            source.removeFeature(featureToRemove);
          }
        }
      }
    }
  }

  /**
   * Re-applies a 'delete' action. (Identical logic to undoAdd).
   */
  private redoDelete(change: StagedChange): void {
    let layerId: number | string | null;

    // Only handle StagedChange types that have 'originalFeatureData'
    if (
      (change.type === 'add' ||
        change.type === 'update' ||
        change.type === 'delete' ||
        change.type === 'split') &&
      'originalFeatureData' in change &&
      change.originalFeatureData
    ) {
      if (Array.isArray(change.originalFeatureData)) {
        // If it's an array, use the first element or handle all
        layerId = change.originalFeatureData[0]?.properties?.layer_id ?? null;
        const uuid = change.originalFeatureData[0]?.properties.uuid;
        const source = this.findLayerOnMap(layerId!)?.getSource();

        if (source && uuid) {
          const compositeId = `${layerId}-${uuid}`;
          const featureToRemove = source.getFeatureById(compositeId);
          if (featureToRemove) {
            source.removeFeature(featureToRemove);
            this.notificationService.showSuccess('Deletion redone.');
          }
        }
      } else {
        // It's a single FeatureData
        layerId = change.originalFeatureData.properties.layer_id;
        const uuid = change.originalFeatureData.properties.uuid;
        const source = this.findLayerOnMap(layerId!)?.getSource();

        if (source && uuid) {
          const compositeId = `${layerId}-${uuid}`;
          const featureToRemove = source.getFeatureById(compositeId);
          if (featureToRemove) {
            source.removeFeature(featureToRemove);
            this.notificationService.showSuccess('Deletion redone.');
          }
        }
      }
    } else {
      console.warn('RedoDelete: originalFeatureData not present on this change type.');
      return;
    }
  }

  /**
   * Re-applies an 'update' action.
   * This removes the original feature and adds the new version.
   */
  private redoUpdate(change: StagedUpdate): void {
    const layerId = change.originalFeatureData.properties.layer_id;
    const uuid = change.originalFeatureData.properties.uuid;
    const source = this.findLayerOnMap(layerId!)?.getSource();

    if (source && uuid && change.newFeatureData) {
      // 1. Remove the "original" state feature from the map
      const compositeId = `${layerId}-${uuid}`;
      const featureToRemove = source.getFeatureById(compositeId);
      if (featureToRemove) {
        source.removeFeature(featureToRemove);
      }

      // 2. Add the "new" (updated) state feature back to the map
      const featureToAdd = this.convertFeatureDataToOlFeature(change.newFeatureData);
      if (featureToAdd) {
        source.addFeature(featureToAdd);
        this.notificationService.showSuccess('Update redone.');
      }
    }
  }

  /**
   * Re-applies a 'split' action.
   * This removes the original feature and adds the two new pieces.
   */
  private redoSplit(change: StageSplit): void {
    const layerId = change.originalFeatureData.properties.layer_id;
    const uuid = change.originalFeatureData.properties.uuid;
    const source = this.findLayerOnMap(layerId!)?.getSource();

    if (source && uuid && change.newFeaturesData) {
      // 1. Remove the original, unsplit feature
      const compositeId = `${layerId}-${uuid}`;
      const featureToRemove = source.getFeatureById(compositeId);
      if (featureToRemove) {
        source.removeFeature(featureToRemove);
      }

      // 2. Add the two new split pieces back
      change.newFeaturesData.forEach((pieceData) => {
        const pieceFeature = this.convertFeatureDataToOlFeature(pieceData);
        if (pieceFeature) {
          source.addFeature(pieceFeature);
        }
      });
      this.notificationService.showSuccess('Split redone.');
    }
  }

  private clearRedoStack(): void {
    if (this.redoStack.length > 0) {
      console.log('[State] A new action was performed. Clearing redo stack.');
      this.redoStack = [];
      this.appStateService.setCanRedo(false);
    }
  }

  /**
   * Converts stored FeatureData back into a usable OpenLayers Feature.
   * This version is "pure" - it does not modify any application state.
   *
   * @param data The feature data to convert.
   * @returns An OpenLayers Feature, or null if conversion fails.
   */

  public convertFeatureDataToOlFeature(data: FeatureData): Feature<Geometry> | null {
    if (!data || !data.geometry || !data.properties) {
      console.error('Cannot convert invalid FeatureData:', data);
      return null;
    }

    const format = new GeoJSON();
    const props = data.properties;
    const layerId = props.layer_id;
    const uuid = props.uuid;

    if (layerId === undefined || !uuid) {
      console.error("FeatureData is missing 'layer_id' or 'uuid' in properties:", props);
      return null;
    }

    const geoJsonFeature = {
      type: 'Feature',
      geometry: data.geometry,
      properties: props,
    };

    // This returns `Feature | Feature[]`, so we must check it.
    const readResult = format.readFeature(geoJsonFeature, {
      dataProjection: 'EPSG:4326',
      featureProjection: this.mapService.getMapInstance()?.getView().getProjection(),
    });

    let feature: Feature<Geometry>;

    // ✅ THE FIX: Use a type guard to check if the result is an array.
    if (Array.isArray(readResult)) {
      // This case should not happen with your `geoJsonFeature` object,
      // but it's robust to handle it.
      if (readResult.length > 0) {
        console.warn('readFeature returned an array, using the first element.');
        feature = readResult[0]; // Take the first feature if it's an array
      } else {
        console.error('readFeature returned an empty array.');
        return null; // Or handle as appropriate
      }
    } else {
      // Inside this 'else' block, TypeScript knows `readResult` is a single Feature.
      feature = readResult;
    }

    // Now it's safe to call .setId() because `feature` is guaranteed to be a single Feature.
    feature.setId(`${layerId}-${uuid}`);

    // Optional but recommended styling logic can go here
    // ...

    return feature;
  }

  getSource(): VectorSource<Feature<Geometry>> | undefined {
    return this.layerService.getDefaultSourceForInteractions();
  }

  createFeature(geometryType: string, coordinates: any, color: string, uuid: string): Feature {
    let geometry;

    switch (geometryType) {
      case 'Point':
        geometry = new Point(coordinates);
        break;
      case 'LineString':
        geometry = new LineString(coordinates);
        break;
      case 'Polygon':
        geometry = new Polygon(coordinates);
        break;
      default:
        throw new Error(`Unsupported geometry type: ${geometryType}`);
    }

    const feature = new Feature({
      geometry,
      uuid, // sets the uuid as a property
    });

    // Add style based on geometry type
    feature.setStyle(
      new Style({
        image:
          geometryType === 'Point'
            ? new CircleStyle({
                radius: 6,
                fill: new Fill({ color }),
                stroke: new Stroke({ color: '#000', width: 1 }),
              })
            : undefined,
        stroke: geometryType !== 'Point' ? new Stroke({ color, width: 2 }) : undefined,
        fill:
          geometryType === 'Polygon'
            ? new Fill({ color: `${color}55` }) // semi-transparent
            : undefined,
      }),
    );

    return feature;
  }

  // in feature.service.ts

  public convertFeatureToFeatureData(
    feature: Feature<Geometry>,
    parentId?: string | null,
    gnd_id?: string | null,
  ): FeatureData | undefined {
    const originalGeometry = feature.getGeometry();
    if (!originalGeometry) {
      console.warn('Feature has no geometry, cannot convert:', feature.getId());
      return undefined;
    }

    // 1. Clone and transform the geometry for the backend
    const mapProjection = this.mapService.getMapViewProjCode();
    const backendProjection = 'EPSG:4326';
    const geometryForBackend = originalGeometry.clone().transform(mapProjection, backendProjection);
    const olGeometryForJson = this.convertOlGeometryToGeoJSON(geometryForBackend);

    if (!olGeometryForJson) {
      return undefined;
    }

    // 2. Extract all properties from the OL Feature
    const properties = feature.getProperties();

    // 3. Construct the final properties object, handling potential inconsistencies
    const featureProperties: FeatureProperties = {
      user_id: properties['user_id'] ?? Number(this.userService.getUser()?.user_id) ?? 0,
      layer_id: properties['layer_id'] ?? null,
      feature_Id: properties['feature_Id'] ?? 0,
      area: properties['area'] ?? 0,
      length: properties['length'] ?? 0,
      parent_uuid: properties['parent_uuid'] ?? parentId ?? null,
      uuid: properties['uuid'] ?? uuidv4(),
      ref_id: properties['ref_id'] ?? null,
      crs: properties['crs'] ?? null,
      // Features loaded from the backend store the GND ID under 'gnd_Id' (capital I).
      // Features built at draw-time use 'gnd_id' (lowercase). Check both.
      gnd_id: properties['gnd_Id'] ?? properties['gnd_id'] ?? gnd_id ?? null,
      isUpdateOnly: properties['isUpdateOnly'] ? true : false,
    };

    // 4. Validate and log any issues
    if (featureProperties.layer_id === null) {
      console.error(`Feature ${featureProperties.uuid} is missing 'layer_id' property!`);
    }
    if (!properties['uuid']) {
      console.warn(`Feature was missing 'uuid' property, generated: ${featureProperties.uuid}`);
    }

    // 5. Construct and return the final FeatureData object
    return {
      geometry: olGeometryForJson,
      properties: featureProperties,
    };
  }

  public convertOlGeometryToGeoJSON(geometry: Geometry): OLGeometry | null {
    try {
      const geometryType = geometry.getType();
      let geojsonGeometry: OLGeometry | null = null;

      switch (geometryType) {
        case 'Point':
          geojsonGeometry = {
            type: 'Point',
            coordinates: (geometry as Point).getCoordinates(),
          };
          break;

        case 'LineString':
          geojsonGeometry = {
            type: 'LineString',
            coordinates: (geometry as LineString).getCoordinates(),
          };
          break;

        case 'Polygon':
          geojsonGeometry = {
            type: 'Polygon',
            coordinates: (geometry as Polygon).getCoordinates(),
          };
          break;

        case 'MultiPolygon':
          geojsonGeometry = {
            type: 'MultiPolygon',
            coordinates: (geometry as MultiPolygon).getCoordinates(),
          };
          break;

        // Optional: Add support for MultiPoint, MultiLineString
        // case 'MultiPoint':
        // case 'MultiLineString':
        //   ...
        //   break;

        default:
          console.warn(`Unsupported OL geometry type: ${geometryType}`);
          return null;
      }

      return geojsonGeometry;
    } catch (error) {
      console.error('Error converting OL Geometry to GeoJSON:', error);
      return null;
    }
    // try {
    //   const geometryType = geometry.getType();
    //   let coordinates: any; // Type varies based on geometry

    //   // Use the standard getCoordinates method - works for these types
    //   switch (geometryType) {
    //     case 'Point':
    //     case 'LineString':
    //     case 'Polygon':
    //     case 'MultiPolygon':
    //       // Add MultiPoint, MultiLineString if needed
    //       // case 'MultiPoint':
    //       // case 'MultiLineString':
    //       coordinates = (geometry as Point | LineString | Polygon | MultiPolygon).getCoordinates();
    //       break;
    //     // case 'Circle': // Circle needs special handling (getCenter, getRadius)
    //     //     console.warn("Circle geometry conversion not fully implemented for backend structure.");
    //     //     return null; // Or convert to a polygon approximation
    //     default:
    //       console.warn(`Unsupported OL geometry type for conversion: ${geometryType}`);
    //       return null; // Return null for unsupported types
    //   }

    //   // Basic validation
    //   if (!coordinates) {
    //     console.error(`Could not extract coordinates for geometry type: ${geometryType}`);
    //     return null;
    //   }

    //   return {
    //     type: geometryType, // Use the actual OL type string
    //     coordinates: coordinates
    //   };
    // } catch (error) {
    //   console.error("Error converting OL Geometry to GeoJSON structure:", error);
    //   return null;
    // }
  }

  clearOriginalFeatures() {
    this.originalFeatures = [];
  }

  /**
   * Undoes a split operation by removing the two new feature pieces
   * and restoring the single original feature.
   *
   * @param change A StagedChange object of type 'split'.
   */

  undoSplit(change: StagedChange) {
    // 1. Validate the incoming change object to ensure it has the required data.
    if (
      change.type !== 'split' ||
      !change.originalFeatureData ||
      !change.newFeaturesData ||
      change.newFeaturesData.length !== 2
    ) {
      console.error("UndoSplit failed: The change object is not a valid 'split' action.", change);
      this.notificationService.showError('Cannot undo split: Corrupted data.');
      return;
    }

    // 2. Extract necessary identifiers. The layer ID from the original feature is the source of truth.
    const originalFeatureData = change.originalFeatureData;
    const newFeaturesData = change.newFeaturesData;
    const layerId = originalFeatureData.properties.layer_id;

    if (layerId === undefined) {
      console.error("UndoSplit failed: The original feature data is missing a 'layer_id'.");
      return;
    }

    // 3. Find the correct layer source on the map.
    const source = this.findLayerOnMap(layerId!)?.getSource();
    if (!source) {
      console.warn(`UndoSplit: Could not find a map source for layer ID ${layerId}.`);
      return;
    }

    // 4. --- REMOVE THE TWO NEW PIECES ---
    // Iterate over the two new features that were created by the split.
    newFeaturesData.forEach((newPieceData) => {
      if (newPieceData.properties && newPieceData.properties.uuid) {
        // Construct the composite ID for the piece we need to remove.
        const compositeIdToRemove = `${layerId}-${newPieceData.properties.uuid}`;
        const featureToRemove = source.getFeatureById(compositeIdToRemove);

        if (featureToRemove) {
          source.removeFeature(featureToRemove);
          console.log(`UndoSplit: Removed split piece with ID ${compositeIdToRemove}.`);
        } else {
          console.warn(
            `UndoSplit: Could not find split piece with ID ${compositeIdToRemove} to remove.`,
          );
        }
      }
    });

    // 5. --- RESTORE THE SINGLE ORIGINAL FEATURE ---
    // Use our robust converter to turn the original data back into an OL feature.
    const featureToRestore = this.convertFeatureDataToOlFeature(originalFeatureData);

    if (featureToRestore) {
      // Add the original, unsplit feature back to the source.
      source.addFeature(featureToRestore);
      console.log(`UndoSplit: Restored original feature with ID ${featureToRestore.getId()}.`);
      this.notificationService.showSuccess('Split undone.');
    } else {
      console.error(
        'UndoSplit: Failed to convert the original feature data back into a map feature.',
      );
      this.notificationService.showError('Failed to restore the original feature.');
    }
  }

  saveFeatures() {
    const payload = this.getFeatureData();

    if (payload.length === 0) {
      this.notificationService.showWarning('No features to save.');
      return;
    }

    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      Authorization: `Token ${this.userToken}`,
    });

    this.http.post(this.apisService.POST_SURVEY_REP_DATA, payload, { headers }).subscribe(
      (response) => {
        console.log('Features saved successfully:', response);
        this.notificationService.showSuccess('Features saved successfully.');
        this.clearFeatureData();
      },
      (error) => {
        console.error('Error saving features:', error);
        const errorMsg = this.getApiErrorMessage(error, 'Failed to save features.');
        this.notificationService.showError(errorMsg);
      },
    );
    this.clearFeatureData();
  }

  private getApiErrorMessage(error: any, fallbackMessage: string): string {
    console.log(error);
    const payload = error?.error ?? error;
    const errorList = payload?.errors;
    if (Array.isArray(errorList) && errorList.length > 0) {
      const detail = errorList[0]?.detail || errorList[0]?.message;
      if (detail) {
        return detail;
      }
    }

    return payload?.detail || payload?.message || payload?.error || fallbackMessage;
  }

  // Function to get style for each geometry type with given color
  getFeatureStyle(geometryType: string, color: string): Style {
    color = this.convertColorNameToHex(color);

    switch (geometryType) {
      case 'Point':
        return new Style({
          image: new CircleStyle({
            radius: 5,
            fill: new Fill({
              color: `${color}30`, // Use a transparent version of the selected color
            }),
            stroke: new Stroke({
              color: color,
              width: 1,
            }),
          }),
        });
      case 'LineString':
        return new Style({
          stroke: new Stroke({
            color: color, // Use the selected color
            width: 1,
          }),
        });
      case 'Polygon':
      case 'MultiPolygon':
        return new Style({
          fill: new Fill({
            color: `${color}30`, // Transparent version of the selected color
          }),
          stroke: new Stroke({
            color: color,
            width: 1,
          }),
        });
      default:
        return new Style();
    }
  }

  //Method to convert color name to hex
  convertColorNameToHex(colorName: string): string {
    // Normalize the color name by removing spaces and converting to lowercase
    const normalizedColorName = colorName.replace(/\s+/g, '').toLowerCase();

    // Create a temporary canvas element
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    // Set the fillStyle to the normalized color name
    if (context) {
      context.fillStyle = normalizedColorName;

      // Get the color as a hex string
      return context.fillStyle;
    }

    return '#000000'; // Default to black if something goes wrong
  }

  deleteFeaturesBatch(ids: number[]): Observable<any> {
    if (!ids || ids.length === 0) {
      console.log('[FeatureService] No UUIDs provided for batch deletion.');
      return of({ success: true, message: 'No features specified for deletion.' });
    }

    const url = this.DELETE_SURVEY_BATCH_DATA; // Use the batch delete endpoint
    const headers = this.getAuthHeaders();
    // *** Adjust payload structure based on your backend requirements ***

    const payload = { ids: ids };

    console.log(`[FeatureService] Sending BATCH DELETE request for ${ids.length} UUIDs:`, ids);

    // --- Choose HTTP Method (DELETE with body or POST) ---
    // NOTE: DELETE requests with a body are sometimes problematic/not standard.
    // POST might be more common for batch delete operations. Check your backend API.

    // Option A: POST for batch delete
    return this.http.delete(url, { headers, body: payload }).pipe(
      tap((response) => {
        console.log('[FeatureService] Batch delete successful:', response);
        this.notificationService.showSuccess;
        // Notification will be handled by the caller (DrawService/ToolsComponent)
      }),
      catchError(this.handleHttpError(`deleteFeaturesBatch (${ids.length} items)`, null)),
    );

    // -----------------------------------------------------
  }
  // --- End Batch Delete Method
}

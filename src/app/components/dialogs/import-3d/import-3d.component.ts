import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Inject,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpEventType } from '@angular/common/http';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { APIsService } from '../../../services/api.service';
import { NotificationService } from '../../../services/notifications.service';
import { qa, qaErr } from '../../../core/qa-log';

export interface Import3dDialogData {
  /** survey_rep.id of the parcel the building is imported onto. */
  parentSuId: number;
  /** Optional human label of the parcel (shown in the header). */
  parcelLabel?: string;
  /** Optional parcel centroid [lon, lat] (EPSG:4326) used as the default anchor. */
  centroidLonLat?: [number, number];
}

export interface Import3dResult {
  building_su_id: number;
  cityjson_id: number;
  footprint_created: boolean;
  units_created: number;
}

@Component({
  selector: 'app-import-3d',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatDialogModule, MatProgressSpinnerModule],
  templateUrl: './import-3d.component.html',
  styleUrl: './import-3d.component.css',
})
export class Import3dComponent {
  private readonly cdr = inject(ChangeDetectorRef);

  file: File | null = null;
  fileError: string | null = null;

  // Manual georeferencing. Two placement modes:
  //  'single' — one anchor (parcel centroid) + rotation/scale (legacy / trivial)
  //  'pairs'  — 2-3 control-point correspondences; system solves rotation+scale
  placementMode: 'single' | 'pairs' = 'pairs';

  // single-anchor mode
  anchorLon: number | null = null;
  anchorLat: number | null = null;
  rotationDeg = 0;
  scale = 1;
  baseZ = 0;

  // multi-anchor mode: rows of { local x/y/z (IFC coords) ↔ lon/lat (WGS84) }
  anchorRows: Array<{
    x: number | null;
    y: number | null;
    z: number | null;
    lon: number | null;
    lat: number | null;
  }> = [
    { x: null, y: null, z: null, lon: null, lat: null },
    { x: null, y: null, z: null, lon: null, lat: null },
  ];

  uploading = false;
  progress = 0;

  constructor(
    public dialogRef: MatDialogRef<Import3dComponent, Import3dResult | undefined>,
    @Inject(MAT_DIALOG_DATA) public data: Import3dDialogData,
    private api: APIsService,
    private notify: NotificationService,
  ) {
    if (data?.centroidLonLat) {
      this.anchorLon = data.centroidLonLat[0];
      this.anchorLat = data.centroidLonLat[1];
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const f = input.files?.[0] ?? null;
    this.setFile(f);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    const f = event.dataTransfer?.files?.[0] ?? null;
    this.setFile(f);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  private setFile(f: File | null): void {
    this.fileError = null;
    if (!f) {
      this.file = null;
      return;
    }
    const name = f.name.toLowerCase();
    if (!name.endsWith('.ifc') && !name.endsWith('.json')) {
      this.file = null;
      this.fileError = 'File must be an IFC (.ifc) or CityJSON (.json).';
      this.cdr.markForCheck();
      return;
    }
    this.file = f;
    this.cdr.markForCheck();
  }

  get isCityJson(): boolean {
    return !!this.file && this.file.name.toLowerCase().endsWith('.json');
  }

  addAnchorRow(): void {
    if (this.anchorRows.length < 5) {
      this.anchorRows.push({ x: null, y: null, z: null, lon: null, lat: null });
    }
  }

  removeAnchorRow(i: number): void {
    if (this.anchorRows.length > 2) this.anchorRows.splice(i, 1);
  }

  /** Rows where all of x, y, lon, lat are filled in. */
  private completeAnchorPairs() {
    return this.anchorRows
      .filter((r) => r.x != null && r.y != null && r.lon != null && r.lat != null)
      .map((r) => ({ local: [r.x, r.y, r.z ?? 0], lon: r.lon, lat: r.lat }));
  }

  get validPairCount(): number {
    return this.completeAnchorPairs().length;
  }

  cancel(): void {
    this.dialogRef.close(undefined);
  }

  submit(): void {
    if (!this.file || this.uploading) return;

    const usepairs = this.placementMode === 'pairs' && !this.isCityJson;
    if (usepairs && this.validPairCount < 2) {
      this.fileError = 'Enter at least 2 complete anchor pairs (X, Y, Lon, Lat).';
      this.cdr.markForCheck();
      return;
    }

    this.uploading = true;
    this.progress = 0;
    this.cdr.markForCheck();

    qa('Import3D', 'submit', {
      file: this.file.name,
      parentSuId: this.data.parentSuId,
      mode: usepairs ? 'anchor_pairs' : 'single',
      pairCount: usepairs ? this.validPairCount : 0,
      anchorLon: this.anchorLon,
      anchorLat: this.anchorLat,
    });

    this.api
      .import3DObject({
        file: this.file,
        parentSuId: this.data.parentSuId,
        anchorPairs: usepairs ? this.completeAnchorPairs() : undefined,
        anchorLon: this.anchorLon ?? undefined,
        anchorLat: this.anchorLat ?? undefined,
        rotationDeg: this.rotationDeg,
        scale: this.scale,
        baseZ: this.baseZ,
      })
      .subscribe({
        next: (event: any) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            this.progress = Math.round((100 * event.loaded) / event.total);
            this.cdr.markForCheck();
          } else if (event.type === HttpEventType.Response) {
            const body = event.body as Import3dResult & { georeferencing?: any };
            this.uploading = false;
            qa('Import3D', 'import OK', {
              building_su_id: body.building_su_id,
              footprint_created: body.footprint_created,
              units_created: body.units_created,
              georeferencing: body.georeferencing, // incl. method + fit_rms_m
            });
            this.notify.showSuccess(
              `Imported: footprint ${body.footprint_created ? 'created' : 'skipped'}, ` +
                `${body.units_created} unit(s).`,
            );
            this.dialogRef.close(body);
          }
        },
        error: (err) => {
          this.uploading = false;
          const detail =
            err?.error?.error || err?.error?.detail || err?.message || 'Import failed.';
          qaErr('Import3D', `import FAILED (HTTP ${err?.status})`, err?.error ?? err);
          this.notify.showError(detail);
          this.cdr.markForCheck();
        },
      });
  }
}

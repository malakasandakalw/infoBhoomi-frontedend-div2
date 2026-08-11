import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  Component,
  OnInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  inject,
} from '@angular/core';

import {
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogModule,
} from '@angular/material/dialog';

import { APIsService } from '../../../../services/api.service';
import { MapService } from '../../../../services/map.service';
import { NotificationService } from '../../../../services/notifications.service';
import { CustomButtonsComponent } from '../../custom-buttons/custom-buttons.component';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-load-temp-data',
  imports: [
    MatDialogClose,
    MatDialogActions,
    MatDialogContent,
    MatDialogModule,
    CustomButtonsComponent,
    CommonModule,
  ],
  templateUrl: './load-temp-data.component.html',
  styleUrl: './load-temp-data.component.css',
})
export class LoadTempDataComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  geoJsonData: any[] = []; // To store the GeoJSON features
  selectedFeature: any = null; // Store selected feature
  isLoading: boolean = true; // Loading state

  constructor(
    private http: HttpClient,
    private mapService: MapService,
    private apiService: APIsService,
    private notificationService: NotificationService,
  ) {}

  ngOnInit(): void {
    this.fetchGeoJsonData();
  }

  fetchGeoJsonData() {
    const token = '579b987dc48287fac501821874298979c736902b';

    this.http
      .get(this.apiService.LOAD_TEMP_VECTOR_DATA('user@email.com'), {
        headers: { Authorization: `Token ${token}` },
      })
      .subscribe(
        (response: any) => {
          this.geoJsonData = response.features;
          this.isLoading = false;
          console.log(response);

          this.cdr.markForCheck();
        },
        (error) => {
          console.error('Error fetching data', error);
          this.isLoading = false;
        },
      );
  }

  onRowSelect(feature: any) {
    this.selectedFeature = feature; // Set the selected row
    console.log(feature);
  }

  removeData(feature: any) {
    const recordId = feature.id; // Get the record's ID
    const token = '579b987dc48287fac501821874298979c736902b';

    // Call the API to delete the record
    this.http
      .delete(this.apiService.REMOVE_TEMP_VECTOR_DATA(recordId), {
        headers: { Authorization: `Token ${token}` },
      })
      .subscribe(
        (response) => {
          console.log();

          // Successfully deleted, now remove the record from the table
          this.geoJsonData = this.geoJsonData.filter((item) => item.id !== recordId);
          // alert('Record deleted successfully');

          this.cdr.markForCheck();
        },
        (error) => {
          console.error('Error deleting record', error);
          this.notificationService.showError('Failed to delete record');
        },
      );
  }
}

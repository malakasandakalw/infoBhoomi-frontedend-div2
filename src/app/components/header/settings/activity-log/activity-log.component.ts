import { CommonModule } from '@angular/common';
import {
  Component,
  ViewChild,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { SortByDatePipePipe } from '../../../../core/pipes/sort-by-date-pipe.pipe';
import { ActivityLogService } from '../../../../services/activity-log.service';
import { LayerService } from '../../../../services/layer.service';
import { ProVersionMessageComponent } from '../../../helpers/pro-version-message/pro-version-message.component';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-activity-log',
  standalone: true,
  imports: [
    MatButtonModule,
    MatDialogModule,
    MatChipsModule,
    CommonModule,
    FormsModule,
    MatTableModule,
    MatPaginatorModule,
    SortByDatePipePipe,
    MatIconModule,
    ProVersionMessageComponent,
  ],
  templateUrl: './activity-log.component.html',
  styleUrl: './activity-log.component.css',
})
export class ActivityLogComponent {
  private readonly cdr = inject(ChangeDetectorRef);
  showProOverlay = true;

  displayedColumns: string[] = []; // Dynamic columns
  dataSource = new MatTableDataSource<any>([]); // Dynamic data source
  @ViewChild(MatPaginator) paginator!: MatPaginator; // Reference the paginator
  selectedChipValue: string = 'Point';
  filteredData: any;
  RetrivedData: any;
  convertChipName: string = '';
  combinedColumns: string[] = []; // Combined columns including 'id'

  // Chips with a label and corresponding URL value
  chips: { label: string; value: string }[] = [
    { label: 'Point', value: 'survey_rep_history_username' },
    { label: 'Line', value: 'survey_rep_history_username' },
    { label: 'Polygon', value: 'survey_rep_history_username' },
    { label: 'Attribute', value: 'history-spartialunit-attrib-username' },
    { label: 'Buffer', value: 'buffer' },
    { label: 'Tag', value: 'tag' },
    { label: 'Reminder', value: 'reminder' },
    { label: 'Inquiry', value: 'inquiry' },
    { label: 'Map with', value: 'map_with' },
    { label: 'Report generation', value: 'report_generation' },
    { label: 'Import', value: 'import' },
    { label: 'Export', value: 'export' },
    { label: 'Print', value: 'print' },
    { label: 'Log in/ Log out', value: 'login_logout' },
    { label: 'Administrative_source', value: 'user-admin-source-activity' },
    { label: 'Feature change/ Delete', value: 'feature_change_delete' },
    { label: 'Rights', value: 'sl-rights-activity' },
    { label: 'Mortgages', value: 'la-mortgage-activity' },
    { label: 'Responsibilities', value: 'la-responsibility-activity' },
    { label: 'Admin_Annotation', value: 'admin-annotation-activity' },
    { label: 'Admin_Restriction', value: 'sl-admin-restrict-activity' },
    { label: 'Liabilities_and_Rights', value: 'sl-rights-lib-activity' },
  ];

  // Column names for each action
  columnNames: { [key: string]: string[] } = {
    Point: ['infobhoomi_id', 'layer', 'geom_type', 'tool', 'user_remark', 'date_created', 'time'],
    Line: ['infobhoomi_id', 'layer', 'geom_type', 'tool', 'user_remark', 'date_created', 'time'],
    Polygon: ['infobhoomi_id', 'layer', 'geom_type', 'tool', 'user_remark', 'date_created', 'time'],
    Attribute: ['infobhoomi_id', 'field_name', 'field_value', 'date_created', 'time'],
    Administrative_source: [
      'infobhoomi_id',
      'ba_unit_id',
      'reference_no',
      'description',
      'acceptance_date',
      'time',
    ],
    Rights: ['su_id', 'right_type', 'party', 'time_spec', 'date_created', 'time'],
    Mortgages: [
      'su_id',
      'sl_mortgage_type',
      'share',
      'amount',
      'int_rate',
      'ranking',
      'mort_id',
      'mortgagor',
      'mortgagee',
      'time_spec',
      'date_created',
      'time',
    ],
    Responsibilities: [
      'su_id',
      'responsibility_type',
      'party',
      'share',
      'time_spec',
      'date_created',
      'time',
    ],
    Admin_Annotation: [
      'su_id',
      'admin_anno_type',
      'share',
      'area',
      'claiment_pid',
      'a_a_parties',
      'time_spec',
      'date_created',
      'time',
    ],
    Admin_Restriction: [
      'su_id',
      'sl_adm_res_type',
      'share',
      'adm_res_legal_space',
      'adm_res_legal_prov',
      'gov_party',
      'time_spec',
      'date_created',
      'time',
    ],
    Liabilities_and_Rights: [
      'su_id',
      'sl_right_type',
      'share',
      'party',
      'sl_rl_parties',
      'time_spec',
      'date_created',
      'time',
    ],
    Buffer: [
      'su_id',
      'sl_right_type',
      'share',
      'party',
      'sl_rl_parties',
      'time_spec',
      'date_created',
      'time',
    ],
    // Add more mappings for each action as needed
  };

  constructor(
    private activitylogService: ActivityLogService,
    private layerService: LayerService,
  ) {}

  ngOnInit(): void {
    this.loadData('survey_rep_history_username', 'Point'); // Load initial data for "point"
  }
  ngAfterViewInit() {
    this.dataSource.paginator = this.paginator; // Set the paginator for the data source
  }

  onChipClick(chipValue: string, chipName: string): void {
    if (this.showProOverlay) return;
    this.selectedChipValue = chipName; // Update the selected chip
    this.loadData(chipValue, chipName); // Load data based on the URL value associated with the chip
  }

  loadData(action: string, chipName: string): void {
    this.displayedColumns = this.columnNames[chipName] || [];
    this.combinedColumns = ['no', ...this.displayedColumns];

    this.activitylogService.GetACtivityLogTableData(action).subscribe(
      async (res: any) => {
        switch (chipName) {
          case 'Point':
          case 'Line':
          case 'Polygon':
            this.convertChipName = chipName === 'Line' ? 'LineString' : chipName;
            this.filteredData = await Promise.all(
              res
                .filter((item: { geom_type: string }) => item.geom_type === this.convertChipName)
                .map(async (item: any) => {
                  // item.layer = await this.layerService.getLayerNameById(item.layer_id);
                  item.infobhoomi_id = item.su_id;
                  return this.processDateAndTime(item, 'date_created'); // Use 'date_created' as the field name
                }),
            );
            break;

          case 'Attribute':
          case 'Rights':
          case 'Mortgages':
          case 'Responsibilities':
          case 'Admin_Annotation':
          case 'Admin_Restriction':
          case 'Liabilities_and_Rights':
            this.filteredData = await Promise.all(
              res.map(async (item: any) => {
                item.infobhoomi_id = item.su_id;
                return this.processDateAndTime(item, 'date_created'); // Use 'date_created' for this case
              }),
            );
            break;

          case 'Administrative_source':
            this.filteredData = await Promise.all(
              res.map(async (item: any) => {
                item.infobhoomi_id = item.su_id;
                return this.processDateAndTime(item, 'acceptance_date'); // Use 'acceptance_date' for this case
              }),
            );
            break;

          default:
            this.filteredData = res;
            break;
        }

        this.dataSource.data = this.filteredData;
        console.error('Error occurred:', this.dataSource.data);

        this.cdr.markForCheck();
      },
      (error) => {
        console.error('Error occurred:', error);
        this.dataSource.data = [];
      },
    );
  }

  trackByFn(index: number, chip: { label: string; value: string }): number {
    return index;
  }

  applyFilter(filterValue: string): void {
    if (this.showProOverlay) return;
    const trimmedFilterValue = filterValue.trim().toLowerCase();

    if (!trimmedFilterValue) {
      // Reset to show the entire table when the filter is empty
      this.dataSource.data = this.filteredData;
    } else {
      // Apply the filter
      this.dataSource.data = this.filteredData.filter((row: any) => {
        return this.displayedColumns.some((column) => {
          return row[column] && row[column].toString().toLowerCase().includes(trimmedFilterValue);
        });
      });
    }
  }

  processDateAndTime(item: any, dateField: string): any {
    if (this.showProOverlay) return;
    const date = new Date(item[dateField]);
    item.sortByDate = date; // Store the original Date object for sorting
    item[dateField] = date.toLocaleDateString(); // Format the date part (without time)
    item.time = date.toLocaleTimeString(); // Format the time part
    return item; // Return the modified item object
  }
}

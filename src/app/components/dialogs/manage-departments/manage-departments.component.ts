//
import {
  Component,
  Inject,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  inject,
} from '@angular/core';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTabsModule } from '@angular/material/tabs';
import { NgSelectModule } from '@ng-select/ng-select';
import { APIsService } from '../../../services/api.service';
import { NotificationService } from '../../../services/notifications.service';
declare var bootstrap: any;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-manage-departments',
  standalone: true,
  imports: [
    MatDialogModule,
    MatTabsModule,
    ReactiveFormsModule,
    FormsModule,
    MatCardModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    NgSelectModule,
  ],
  templateUrl: './manage-departments.component.html',
  styleUrl: './manage-departments.component.css',
})
export class ManageDepartmentsComponent {
  private readonly cdr = inject(ChangeDetectorRef);
  departments_list: any = [];
  private all_departments: any = [];
  searchQuery = '';
  admin_password = '';
  selected_department: any;
  department_name = '';

  ngOnInit(): void {
    this.getDepartmentList();
  }

  passwordVisible: boolean = false;

  togglePasswordVisibility() {
    this.passwordVisible = !this.passwordVisible;
  }

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: any,
    public dialogRef: MatDialogRef<ManageDepartmentsComponent>,
    private apiService: APIsService,
    private dialog: MatDialog,
    private notificationService: NotificationService,
  ) {}

  getDepartmentList() {
    this.apiService.getDepartments().subscribe((res) => {
      this.all_departments = res.map((item: any) => ({ ...item, edit: false }));
      this.filterDepartments();

      this.cdr.markForCheck();
    });
  }

  filterDepartments() {
    const q = this.searchQuery.toLowerCase();
    this.departments_list = q
      ? this.all_departments.filter((d: { dep_name: string }) =>
          d.dep_name.toLowerCase().includes(q),
        )
      : [...this.all_departments];
  }
  editDepartment(item: any) {
    item.edit = true;
  }
  openDeleteModal(data: any) {
    this.selected_department = data;
    const modalElement = document.getElementById('confirmDeleteModal');
    let modal: any;
    if (modalElement) {
      modal = new bootstrap.Modal(modalElement, {
        backdrop: false, // Disable backdrop to prevent overlay issues
        keyboard: true,
      });
    }
    modal.show();
  }

  confirmDelete() {
    if (this.admin_password != '') {
      let input_data = {
        password: this.admin_password,
      };
      this.apiService.postPassword(input_data).subscribe((res) => {
        this.apiService.deleteDepartment(this.selected_department.dep_id).subscribe(
          (response: any) => {
            this.notificationService.showSuccess('Department removed successfully!');
            const modal = bootstrap.Modal.getInstance(
              document.getElementById('confirmDeleteModal'),
            );
            modal.hide();
          },
          (error: any) => {
            console.error('Error saving administrative info:', error);
            if (error?.error?.non_field_errors) {
              this.notificationService.showError('Department could not be removed');
            } else {
              this.notificationService.showError('Department could not be removed');
            }
          },
        );
      });
    }
  }

  updateDepartment(selected_department: any) {
    if (!selected_department.dep_name?.trim()) {
      this.notificationService.showError('Department name cannot be empty.');
      return;
    }
    selected_department.edit = false;
    let input_data = {
      dep_name: selected_department.dep_name.trim(),
    };
    this.apiService.updateDepartment(input_data, selected_department.dep_id).subscribe(
      (_response: any) => {
        this.notificationService.showSuccess('Department updated successfully.');
      },
      (error: any) => {
        console.error('Error saving administrative info:', error);
        if (error?.error?.non_field_errors) {
          this.notificationService.showError('Data not saved');
        } else {
          this.notificationService.showError('Data not saved');
        }
      },
    );
  }

  SubmitAll() {
    if (!this.department_name?.trim()) {
      this.notificationService.showError('Please enter a department name.');
      return;
    }
    let input_data = {
      dep_name: this.department_name.trim(),
    };
    this.apiService.createDepartment(input_data).subscribe(
      (response: any) => {
        this.department_name = '';
        this.getDepartmentList();
        this.notificationService.showSuccess('Data saved successfully');

        this.cdr.markForCheck();
      },
      (error: any) => {
        console.error('Error saving administrative info:', error);
        this.notificationService.showError(error.error?.error || 'Data not saved');
        // if (error?.error?.non_field_errors) {
        // } else {
        //   this.notificationService.showError('Data not saved');
        // }
      },
    );
  }

  closeDialog(): void {
    this.dialogRef.close();
  }
}

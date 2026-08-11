import { CommonModule } from '@angular/common'; //
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
import { AdminService } from '../../../services/admin.service';
import { APIsService } from '../../../services/api.service';
import { NotificationService } from '../../../services/notifications.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-add-role-users',
  standalone: true,
  imports: [
    MatDialogModule,
    MatTabsModule,
    ReactiveFormsModule,
    FormsModule,
    MatCardModule,
    MatIconModule,
    CommonModule,
    MatFormFieldModule,
    MatInputModule,
    NgSelectModule,
  ],
  templateUrl: './add-role-users.component.html',
  styleUrl: './add-role-users.component.css',
})
export class AddRoleUsersComponent {
  private readonly cdr = inject(ChangeDetectorRef);
  role_user: any = [];
  searchQuery = '';
  selected_role_id: any;
  selected_role_users = new Set<number>();
  user_add = false;
  loading = false;

  ngOnInit(): void {
    this.addUserToRole();
  }

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: any,
    public dialogRef: MatDialogRef<AddRoleUsersComponent>,
    private apiService: APIsService,
    private dialog: MatDialog,
    private notificationService: NotificationService,
    public adminService: AdminService,
  ) {
    this.selected_role_id = this.data.role_data.role_id;
    this.filterUserIDs();
  }

  filterUserIDs() {
    for (const u of this.data.role_data.users ?? []) {
      this.selected_role_users.add(u.id);
    }
  }

  addNewUser(u: any) {
    this.selected_role_users.add(u.id);
    this.user_add = true;
  }

  onToggleUser(u: any, checked: boolean) {
    if (checked) {
      this.selected_role_users.add(u.id);
    } else {
      this.selected_role_users.delete(u.id);
    }
  }

  isSelected(u: any) {
    return this.selected_role_users.has(u.id);
  }

  addUserToRole() {
    this.apiService.getAdminRoleUsers().subscribe((res: any) => {
      this.role_user = (res || []).sort((a: any, b: any) =>
        a.department.localeCompare(b.department),
      );
      const q = this.searchQuery.trim().toLowerCase();
      if (q) {
        this.role_user = this.role_user.filter((user: any) =>
          [user.username, user.email, user.first_name].some((f) =>
            f?.toString().toLowerCase().includes(q),
          ),
        );
      }

      this.cdr.markForCheck();
    });
  }

  SubmitAll() {
    this.loading = true;
    const input_data = {
      users: Array.from(this.selected_role_users),
    };
    this.apiService.addUsersToRole(input_data, this.selected_role_id).subscribe({
      next: () => {
        this.loading = false;
        this.dialogRef.close(this.data.role_data);
        this.notificationService.showSuccess('Data saved successfully');

        this.cdr.markForCheck();
      },
      error: (error) => {
        this.loading = false;
        console.error('Error saving role users:', error);
        this.notificationService.showError(error.error?.error || 'Data not saved');
      },
    });
  }

  closeDialog(): void {
    this.dialogRef.close();
  }
}

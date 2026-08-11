import {
  Component,
  OnInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { APIsService } from '../../../services/api.service';
import { LoaderComponent } from '../../side-panel/loader/loader.component';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-admin-contact',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    FormsModule,
    MatTooltipModule,
    MatDividerModule,
    LoaderComponent,
  ],
  templateUrl: './admin-contact.component.html',
  styleUrl: './admin-contact.component.css',
})
export class AdminContactComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  email = '';
  first_name = '';
  last_name = '';
  mobile = '';
  post = '';

  loading = false;

  constructor(private apiService: APIsService) {}

  async ngOnInit(): Promise<void> {
    await this.getContactDetails();
  }

  async getContactDetails() {
    this.loading = true;
    this.apiService.getAdminContactInfo().subscribe({
      next: (res: any) => {
        // this.logins = res;
        this.first_name = res[0].first_name;
        this.last_name = res[0].last_name;
        this.email = res[0].email;
        this.mobile = res[0].mobile;
        this.post = res[0].post;
        this.loading = false;

        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loading = false;
        console.error('Failed to load contact details', err);
      },
    });
  }
}

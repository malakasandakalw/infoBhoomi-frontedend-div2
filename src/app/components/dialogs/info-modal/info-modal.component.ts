import { CommonModule } from '@angular/common';
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
import { finalize } from 'rxjs';
import { APIsService } from '../../../services/api.service';
import { DrawService } from '../../../services/draw.service';
import { NotificationService } from '../../../services/notifications.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-info-modal',
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    CommonModule,
    FormsModule,
    MatTooltipModule,
    MatDividerModule,
  ],
  templateUrl: './info-modal.component.html',
  styleUrl: './info-modal.component.css',
})
export class InfoModalComponent implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  name: string | null = null;
  id: string | null = null;
  createdAt: Date | string | null = null;
  email: string | null = null;

  constructor(
    private drawService: DrawService,
    private apiService: APIsService,
    private notificationService: NotificationService,
  ) {}

  ngOnInit(): void {
    console.log(this.drawService.getSelectedFeatureId());
    this.getCreatedByDetails();
  }

  async getCreatedByDetails() {
    if (this.drawService.getSelectedFeatureId()) {
      this.apiService
        .getCreatedByDetails(this.drawService.getSelectedFeatureId())
        .pipe(finalize(() => {}))
        .subscribe({
          next: (res: any) => {
            if (res) {
              console.log(res);
              this.id = res.id;
              this.name = res.first_name + ' ' + res.last_name;
              this.createdAt = res.date_created;
              this.email = res.email;
            }

            this.cdr.markForCheck();
          },
          error: (err) => {
            console.log('Get created by details error: ', err);
          },
        });
    } else {
      this.notificationService.showError('Please select a feature');
    }
  }
}

import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import type { SalesTrendPoint } from '@analytics-admin/contracts';
import {
  AriaComponent,
  GridComponent,
  TooltipComponent,
} from 'echarts/components';
import { LineChart } from 'echarts/charts';
import { init, use, type ECharts } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { ThemeService } from '../../theme.service';

use([AriaComponent, GridComponent, LineChart, SVGRenderer, TooltipComponent]);

type TrendMetric = 'aov' | 'orders' | 'revenue';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'aad-sales-trend-chart',
  template: `
    <div class="metric-tabs" role="group" aria-label="Trend metric">
      <button
        type="button"
        [attr.aria-pressed]="metric() === 'revenue'"
        (click)="selectMetric('revenue')"
      >
        Revenue
      </button>
      <button
        type="button"
        [attr.aria-pressed]="metric() === 'orders'"
        (click)="selectMetric('orders')"
      >
        Orders
      </button>
      <button
        type="button"
        [attr.aria-pressed]="metric() === 'aov'"
        (click)="selectMetric('aov')"
      >
        AOV
      </button>
    </div>
    <div #chart class="chart" role="img"></div>
    <details>
      <summary>View chart values as a table</summary>
      <div class="table-scroll">
        <table>
          <caption class="sr-only">
            Sales trend values
          </caption>
          <thead>
            <tr>
              <th>Date</th>
              <th>Net revenue</th>
              <th>Orders</th>
              <th>Average order value</th>
            </tr>
          </thead>
          <tbody>
            @for (point of points(); track point.bucketStart) {
              <tr>
                <td>{{ dateLabel(point.bucketStart) }}</td>
                <td>{{ money(point.revenueMinor) }}</td>
                <td>{{ point.orderCount }}</td>
                <td>{{ money(point.averageOrderValueMinor) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </details>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .chart {
      position: relative;
      width: 100%;
      height: 310px;
      overflow: hidden;
    }
    .metric-tabs {
      display: inline-grid;
      grid-auto-flow: column;
      gap: 3px;
      margin-top: 14px;
      padding: 3px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface-muted);
    }
    .metric-tabs button {
      min-height: 32px;
      padding: 0 11px;
      border: 0;
      border-radius: 7px;
      color: var(--text-muted);
      background: transparent;
      font-size: 0.67rem;
      font-weight: 760;
      cursor: pointer;
    }
    .metric-tabs button[aria-pressed='true'] {
      color: var(--text);
      background: var(--surface-raised);
      box-shadow: 0 2px 8px rgba(24, 40, 36, 0.08);
    }
    details {
      margin-top: 8px;
    }
    summary {
      color: var(--text-muted);
      font-size: 0.7rem;
      font-weight: 700;
      cursor: pointer;
    }
    .table-scroll {
      max-height: 230px;
      margin-top: 10px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.7rem;
    }
    th,
    td {
      padding: 9px 10px;
      border-bottom: 1px solid var(--border);
      text-align: left;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--surface-raised);
    }
    td:nth-child(n + 2),
    th:nth-child(n + 2) {
      text-align: right;
    }
    @media (max-width: 620px) {
      .chart {
        height: 250px;
      }
    }
  `,
})
export class SalesTrendChartComponent implements OnDestroy {
  readonly currency = input.required<string>();
  readonly points = input.required<readonly SalesTrendPoint[]>();
  protected readonly metric = signal<TrendMetric>('revenue');
  private readonly element = viewChild<ElementRef<HTMLDivElement>>('chart');
  private readonly theme = inject(ThemeService);
  private chart?: ECharts;
  private resizeObserver?: ResizeObserver;

  constructor() {
    afterNextRender(() => {
      const element = this.element()?.nativeElement;
      if (!element) return;
      this.chart = init(element, undefined, { renderer: 'svg' });
      this.resizeObserver = new ResizeObserver(() => this.chart?.resize());
      this.resizeObserver.observe(element);
      this.render();
    });
    effect(() => {
      this.points();
      this.currency();
      this.metric();
      this.theme.theme();
      this.render();
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.chart?.dispose();
  }

  protected dateLabel(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(value));
  }

  protected money(value: string): string {
    return formatMoney(value, this.currency());
  }

  protected selectMetric(metric: TrendMetric): void {
    this.metric.set(metric);
  }

  private render(): void {
    if (!this.chart) return;
    const points = this.points();
    const styles = getComputedStyle(
      this.element()?.nativeElement ?? document.body,
    );
    const currency = this.currency();
    const metric = trendMetric(this.metric(), currency);
    this.chart.setOption(
      {
        aria: {
          enabled: true,
          description: `Line chart of ${metric.description} across ${points.length} reporting periods. A complete data table follows the chart.`,
        },
        grid: {
          bottom: 34,
          left: 8,
          outerBoundsContain: 'axisLabel',
          outerBoundsMode: 'same',
          right: 12,
          top: 20,
        },
        series: [
          {
            areaStyle: {
              color: styles.getPropertyValue('--accent-soft').trim(),
              opacity: 0.58,
            },
            data: points.map(metric.value),
            emphasis: { focus: 'series' },
            lineStyle: {
              color: styles.getPropertyValue('--accent').trim(),
              width: 2.5,
            },
            name: metric.label,
            showSymbol: points.length < 20,
            smooth: 0.25,
            symbolSize: 7,
            type: 'line',
          },
        ],
        textStyle: {
          color: styles.getPropertyValue('--text-muted').trim(),
          fontFamily: 'system-ui, sans-serif',
          fontSize: 11,
        },
        tooltip: {
          trigger: 'axis',
          valueFormatter: (value: unknown) => metric.format(Number(value)),
        },
        xAxis: {
          axisLabel: {
            hideOverlap: true,
            formatter: (_value: string, index: number) =>
              this.dateLabel(points[index]?.bucketStart ?? ''),
          },
          axisLine: {
            lineStyle: { color: styles.getPropertyValue('--border').trim() },
          },
          data: points.map((point) => point.bucketStart),
          type: 'category',
        },
        yAxis: {
          axisLabel: { formatter: metric.axis },
          splitLine: {
            lineStyle: {
              color: styles.getPropertyValue('--border').trim(),
              type: 'dashed',
            },
          },
          type: 'value',
        },
      },
      true,
    );
  }
}

function trendMetric(metric: TrendMetric, currency: string) {
  const money = (value: number) =>
    new Intl.NumberFormat(undefined, { currency, style: 'currency' }).format(
      value,
    );
  if (metric === 'orders') {
    return {
      axis: compactNumber,
      description: 'sales order volume',
      format: (value: number) => Math.round(value).toLocaleString(),
      label: 'Orders',
      value: (point: SalesTrendPoint) => point.orderCount,
    };
  }
  const average = metric === 'aov';
  return {
    axis: compactNumber,
    description: average
      ? `average order value in ${currency}`
      : `net sales revenue in ${currency}`,
    format: money,
    label: average ? 'Average order value' : 'Net revenue',
    value: (point: SalesTrendPoint) =>
      Number(average ? point.averageOrderValueMinor : point.revenueMinor) / 100,
  };
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: 'compact',
  }).format(value);
}

function formatMoney(minor: string, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    currency,
    style: 'currency',
  }).format(Number(minor) / 100);
}

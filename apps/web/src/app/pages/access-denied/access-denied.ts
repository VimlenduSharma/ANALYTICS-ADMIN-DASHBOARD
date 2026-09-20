import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <section class="access-state" aria-labelledby="access-title">
      <span aria-hidden="true">403</span>
      <p>Permission boundary</p>
      <h1 id="access-title">This workspace is outside your role.</h1>
      <p class="copy">
        Your session is valid, but this organization or action requires a
        different membership. No data was disclosed or changed.
      </p>
      <a routerLink="/">Return to your workspace</a>
    </section>
  `,
  styles: `
    .access-state {
      width: min(760px, calc(100% - 36px));
      margin: 0 auto;
      padding: clamp(70px, 12vw, 150px) 0;
    }
    .access-state > span {
      color: color-mix(in srgb, var(--text-muted) 22%, transparent);
      font:
        500 clamp(5rem, 16vw, 10rem)/0.8 ui-monospace,
        monospace;
    }
    .access-state > p:first-of-type {
      margin: 36px 0 10px;
      color: var(--accent-strong);
      font-size: 0.7rem;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    h1 {
      max-width: 650px;
      margin: 0;
      font-size: clamp(2.2rem, 6vw, 4.8rem);
      line-height: 1;
      letter-spacing: -0.06em;
    }
    .copy {
      max-width: 570px;
      margin: 22px 0;
      color: var(--text-muted);
      line-height: 1.7;
    }
    a {
      display: inline-grid;
      place-items: center;
      min-height: 44px;
      padding: 0 17px;
      border-radius: 10px;
      color: var(--surface);
      background: var(--text);
      font-size: 0.82rem;
      font-weight: 750;
      text-decoration: none;
    }
  `,
})
export class AccessDeniedPage {}

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import type { OrganizationAccess } from '@analytics-admin/contracts';
import { UiDialogComponent } from '../shared/ui/ui-dialog';
import { AppearancePreferencesComponent } from './appearance-preferences';

type Command =
  | {
      hint: string;
      id: string;
      kind: 'navigate';
      label: string;
      path: string;
      section: string;
    }
  | {
      hint: string;
      id: string;
      kind: 'organization';
      label: string;
      organizationId: string;
      section: string;
    }
  | {
      hint: string;
      id: string;
      kind: 'preferences';
      label: string;
      section: string;
    };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppearancePreferencesComponent, UiDialogComponent],
  selector: 'aad-command-menu',
  template: `
    <aad-dialog
      [open]="open()"
      [labelledBy]="
        view() === 'commands' ? 'command-title' : 'command-preferences-title'
      "
      [describedBy]="
        view() === 'commands'
          ? 'command-help'
          : 'command-preferences-description'
      "
      (dismissed)="close()"
    >
      @if (view() === 'preferences') {
        <aad-appearance-preferences
          headingId="command-preferences-title"
          descriptionId="command-preferences-description"
          groupName="command-preferences"
          [autoFocus]="true"
          (closed)="close()"
        />
      } @else {
        <div class="command">
          <header>
            <span aria-hidden="true">⌘</span>
            <div>
              <h2 id="command-title">Find anything</h2>
              <p id="command-help">Search views, settings, or organizations.</p>
            </div>
            <kbd>Esc</kbd>
          </header>
          <label for="command-search" class="sr-only">Search workspace</label>
          <input
            id="command-search"
            data-dialog-focus
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            autocomplete="off"
            placeholder="Type a command or organization…"
            aria-controls="command-results"
            [attr.aria-expanded]="open()"
            [attr.aria-activedescendant]="activeCommandId()"
            [value]="query()"
            (input)="updateQuery($event)"
            (keydown)="handleKeydown($event)"
          />

          <ul
            id="command-results"
            role="listbox"
            aria-label="Workspace commands"
          >
            @for (
              command of filteredCommands();
              track command.id;
              let index = $index
            ) {
              <li
                role="option"
                [id]="'command-' + command.id"
                [attr.aria-selected]="activeIndex() === index"
                [class.is-active]="activeIndex() === index"
                (mousemove)="activeIndex.set(index)"
                (pointerup)="run(command)"
              >
                <span class="command-icon" aria-hidden="true">
                  {{
                    command.kind === 'organization'
                      ? 'O'
                      : command.kind === 'preferences'
                        ? 'P'
                        : '↗'
                  }}
                </span>
                <p>
                  <strong>{{ command.label }}</strong
                  ><small>{{ command.hint }}</small>
                </p>
                <span>{{ command.section }}</span>
              </li>
            } @empty {
              <li
                class="empty"
                role="option"
                aria-disabled="true"
                aria-selected="false"
              >
                No commands match “{{ query() }}”
              </li>
            }
          </ul>
          <footer>
            <span><kbd>↑</kbd><kbd>↓</kbd> Move</span>
            <span><kbd>Enter</kbd> Open</span>
            <span>Queries are never saved</span>
          </footer>
        </div>
      }
    </aad-dialog>
  `,
  styleUrl: './command-menu.css',
})
export class CommandMenuComponent {
  readonly canManageSelected = input(false);
  readonly dismissed = output<void>();
  readonly open = input(false);
  readonly organizationSelected = output<string>();
  readonly organizations = input<readonly OrganizationAccess[]>([]);
  readonly selectedOrganizationId = input<string | undefined>();
  protected readonly activeIndex = signal(0);
  protected readonly query = signal('');
  protected readonly view = signal<'commands' | 'preferences'>('commands');
  private readonly router = inject(Router);

  protected readonly filteredCommands = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    const commands = this.commands();
    return query
      ? commands.filter((command) =>
          [command.label, command.hint, command.section].some((value) =>
            value.toLocaleLowerCase().includes(query),
          ),
        )
      : commands;
  });
  protected readonly activeCommandId = computed(() => {
    const command = this.filteredCommands()[this.activeIndex()];
    return command ? `command-${command.id}` : null;
  });

  protected updateQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.activeIndex.set(0);
  }

  protected handleKeydown(event: KeyboardEvent): void {
    const commands = this.filteredCommands();
    if (!commands.length) return;
    const last = commands.length - 1;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex.update((index) => (index >= last ? 0 : index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex.update((index) => (index <= 0 ? last : index - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.activeIndex.set(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      this.activeIndex.set(last);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = commands[this.activeIndex()];
      if (command) this.run(command);
    }
  }

  protected run(command: Command): void {
    if (command.kind === 'preferences') {
      this.query.set('');
      this.activeIndex.set(0);
      this.view.set('preferences');
      return;
    }
    if (command.kind === 'navigate')
      void this.router.navigateByUrl(command.path);
    if (command.kind === 'organization') {
      this.organizationSelected.emit(command.organizationId);
    }
    this.close();
  }

  protected close(): void {
    this.query.set('');
    this.activeIndex.set(0);
    this.view.set('commands');
    this.dismissed.emit();
  }

  private commands(): Command[] {
    const selectedId = this.selectedOrganizationId();
    const commands: Command[] = [
      {
        hint: 'Workspace status and organization access',
        id: 'overview',
        kind: 'navigate',
        label: 'Open overview',
        path: '/',
        section: 'Navigate',
      },
      {
        hint: 'Your name, locale, and timezone',
        id: 'profile',
        kind: 'navigate',
        label: 'Open profile settings',
        path: '/profile',
        section: 'Settings',
      },
      {
        hint: 'Reusable components and interaction states',
        id: 'patterns',
        kind: 'navigate',
        label: 'Open interface patterns',
        path: '/workspace/components',
        section: 'Navigate',
      },
      {
        hint: 'Theme and reduced-motion settings',
        id: 'preferences',
        kind: 'preferences',
        label: 'Open appearance preferences',
        section: 'Settings',
      },
    ];
    if (selectedId) {
      commands.splice(1, 0, {
        hint: 'Revenue, orders, segments, and exports',
        id: 'sales',
        kind: 'navigate',
        label: 'Open sales analytics',
        path: `/organizations/${selectedId}/sales`,
        section: 'Navigate',
      });
      commands.splice(2, 0, {
        hint: 'Backlog, service levels, stock risk, and alerts',
        id: 'operations',
        kind: 'navigate',
        label: 'Open operations control',
        path: `/organizations/${selectedId}/operations`,
        section: 'Navigate',
      });
    }
    if (selectedId && this.canManageSelected()) {
      commands.splice(1, 0, {
        hint: 'Sources, invitations, retention, privacy, and audit',
        id: 'governance',
        kind: 'navigate',
        label: 'Open governance control',
        path: `/organizations/${selectedId}/governance`,
        section: 'Navigate',
      });
      commands.splice(2, 0, {
        hint: 'Members, roles, and access history',
        id: 'team',
        kind: 'navigate',
        label: 'Open team access',
        path: `/organizations/${selectedId}/team`,
        section: 'Navigate',
      });
    }
    commands.push(
      ...this.organizations().map<Command>((organization) => ({
        hint: `${organization.role} access`,
        id: `organization-${organization.id}`,
        kind: 'organization',
        label: organization.name,
        organizationId: organization.id,
        section: 'Organization',
      })),
    );
    return commands;
  }
}

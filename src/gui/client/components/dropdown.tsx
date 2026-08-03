import type { TargetedFocusEvent } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

const LIMIT = 50;

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
}

function filterOptions(options: DropdownOption[], text: string): DropdownOption[] {
  const query = text.trim().toLowerCase();
  if (!query) return options;
  return options.filter(
    (option) =>
      option.value.toLowerCase().includes(query) ||
      option.label.toLowerCase().includes(query) ||
      option.description?.toLowerCase().includes(query),
  );
}

export function resolveOption(options: DropdownOption[], text: string): DropdownOption | null {
  const query = text.trim().toLowerCase();
  if (!query) return null;
  const exact = options.find((option) => option.value.toLowerCase() === query);
  if (exact) return exact;
  const matches = filterOptions(options, text);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

interface DropdownProps {
  id: string;
  label: string;
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchable?: boolean;
  filterable?: boolean;
  onSubmit?: () => void;
  emptyText?: string;
  disabled?: boolean;
}

export function Dropdown({
  id,
  label,
  options,
  value,
  onChange,
  placeholder = 'Select an option',
  searchable = false,
  filterable = false,
  onSubmit,
  emptyText = 'No matching options.',
  disabled = false,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  const typeaheadRef = useRef({ text: '', time: 0 });
  const unavailable = disabled || options.length === 0;
  const interactiveSearch = searchable || filterable;
  const matches = searchable ? filterOptions(options, value) : filterable ? filterOptions(options, query) : options;
  const shown = matches.slice(0, LIMIT);
  const clamped = Math.min(highlight, Math.max(0, shown.length - 1));
  const selected = options.find((option) => option.value === value);
  const listId = `${id}-options`;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      const control = rootRef.current?.querySelector<HTMLElement>('[role="combobox"]');
      const pop = popRef.current;
      if (!control || !pop) return;
      const rect = control.getBoundingClientRect();
      const inset = 8;
      const gap = 4;
      const width = Math.min(rect.width, window.innerWidth - inset * 2);
      const left = Math.min(Math.max(inset, rect.left), window.innerWidth - width - inset);
      const height = pop.offsetHeight;
      const below = window.innerHeight - rect.bottom - inset;
      const above = rect.top - inset;
      const top =
        height > below && above > below
          ? Math.max(inset, rect.top - gap - height)
          : Math.min(rect.bottom + gap, window.innerHeight - height - inset);
      setPosition({ left, top, width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, matches.length]);

  useEffect(() => {
    popRef.current?.querySelector('.dropdown-option.hot')?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const pick = (option: DropdownOption) => {
    onChange(option.value);
    if (filterable) setQuery('');
    setOpen(false);
  };

  const openAtSelection = () => {
    const index = Math.max(
      0,
      shown.findIndex((option) => option.value === value),
    );
    setHighlight(index);
    setOpen(true);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!shown.length) return;
      if (open) {
        setHighlight((clamped + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
      } else {
        openAtSelection();
      }
    } else if (event.key === 'Home' && open && shown.length) {
      event.preventDefault();
      setHighlight(0);
    } else if (event.key === 'End' && open && shown.length) {
      event.preventDefault();
      setHighlight(shown.length - 1);
    } else if (event.key === 'Enter' || (!interactiveSearch && event.key === ' ')) {
      event.preventDefault();
      if (open && shown.length) pick(shown[clamped]!);
      else if (searchable) onSubmit?.();
      else openAtSelection();
    } else if (event.key === 'Escape') {
      setOpen(false);
    } else if (!interactiveSearch && event.key.length === 1 && /\S/.test(event.key)) {
      const now = Date.now();
      const previous = typeaheadRef.current;
      const query = `${now - previous.time < 500 ? previous.text : ''}${event.key}`.toLowerCase();
      typeaheadRef.current = { text: query, time: now };
      const match = options.find((option) => option.label.toLowerCase().startsWith(query));
      if (match) pick(match);
    }
  };

  const onBlur = (event: TargetedFocusEvent<HTMLElement>) => {
    const target = event.relatedTarget;
    if (!(target instanceof Node) || (!rootRef.current?.contains(target) && !popRef.current?.contains(target))) {
      setOpen(false);
    }
  };

  return (
    <div class={`field dropdown ${open ? 'open' : ''}`} ref={rootRef}>
      <label class="field-label" for={id}>
        {label}
      </label>
      {interactiveSearch ? (
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={open && !unavailable}
          aria-controls={listId}
          aria-activedescendant={open && shown.length ? `${id}-option-${clamped}` : undefined}
          autocomplete="off"
          spellcheck={false}
          disabled={unavailable}
          placeholder={placeholder}
          value={filterable ? (open ? query : (selected?.label ?? '')) : value}
          onInput={(event) => {
            setHighlight(0);
            setOpen(true);
            if (filterable) setQuery(event.currentTarget.value);
            else onChange(event.currentTarget.value);
          }}
          onFocus={() => {
            if (filterable) setQuery('');
            if (!unavailable) setOpen(true);
          }}
          onClick={() => {
            if (!open && !unavailable) {
              if (filterable) setQuery('');
              setOpen(true);
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
      ) : (
        <button
          id={id}
          type="button"
          class="dropdown-trigger"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open && !unavailable}
          aria-controls={listId}
          aria-activedescendant={open && shown.length ? `${id}-option-${clamped}` : undefined}
          disabled={unavailable}
          onClick={() => {
            if (open) setOpen(false);
            else openAtSelection();
          }}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        >
          <span>{selected?.label ?? placeholder}</span>
          <span class="dropdown-arrow" aria-hidden="true" />
        </button>
      )}
      {open &&
        !unavailable &&
        createPortal(
          <div
            id={listId}
            class="dropdown-pop"
            role="listbox"
            aria-label={label}
            ref={popRef}
            style={
              position
                ? `left:${position.left}px;top:${position.top}px;width:${position.width}px`
                : 'left:0;top:0;visibility:hidden'
            }
          >
            {shown.length ? (
              shown.map((option, index) => (
                <div
                  id={`${id}-option-${index}`}
                  key={option.value}
                  class={`dropdown-option ${index === clamped ? 'hot' : ''}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={option.value === value}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    pick(option);
                  }}
                >
                  <span class="dropdown-value">{option.label}</span>
                  {option.description && option.description !== option.label && <small>{option.description}</small>}
                </div>
              ))
            ) : (
              <div class="dropdown-empty">{emptyText}</div>
            )}
            {matches.length > shown.length && (
              <div class="dropdown-empty">+ {matches.length - shown.length} more. Keep typing to narrow.</div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

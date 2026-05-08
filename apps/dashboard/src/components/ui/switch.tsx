import { cn } from '@/lib/utils';
import * as React from 'react';

export interface SwitchProps {
  readonly id?: string;
  readonly checked?: boolean;
  readonly defaultChecked?: boolean;
  readonly disabled?: boolean;
  readonly name?: string;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly className?: string;
  readonly 'aria-label'?: string;
}

/**
 * Pill toggle. Controlled or uncontrolled. Backed by a hidden checkbox so
 * forms work without extra plumbing.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ id, checked, defaultChecked, disabled, name, onCheckedChange, className, ...rest }, ref) => {
    const [internal, setInternal] = React.useState<boolean>(defaultChecked ?? false);
    const isControlled = checked !== undefined;
    const value = isControlled ? checked : internal;

    const toggle = (): void => {
      if (disabled) return;
      const next = !value;
      if (!isControlled) setInternal(next);
      onCheckedChange?.(next);
    };

    return (
      <button
        ref={ref}
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        disabled={disabled}
        onClick={toggle}
        className={cn(
          'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
          value ? 'bg-primary' : 'bg-input',
          className,
        )}
        {...rest}
      >
        <span
          aria-hidden
          className={cn(
            'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
            value ? 'translate-x-4' : 'translate-x-0',
          )}
        />
        {name ? <input type="hidden" name={name} value={value ? 'true' : 'false'} /> : null}
      </button>
    );
  },
);
Switch.displayName = 'Switch';

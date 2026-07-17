"use client";

import {
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  useId,
} from "react";
import { cn } from "@/src/lib/cn";
import { Icon } from "./icon";

interface FieldBaseProps {
  error?: string;
  hint?: string;
  label: string;
}

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id">,
    FieldBaseProps {
  id?: string;
  mono?: boolean;
}

export function Input({
  className,
  error,
  hint,
  id: providedId,
  label,
  mono = false,
  ...props
}: InputProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const messageId = `${id}-message`;
  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">{label}</span>
      <input
        aria-describedby={error || hint ? messageId : undefined}
        aria-invalid={Boolean(error)}
        className={cn("field__control", mono && "mono", className)}
        id={id}
        {...props}
      />
      <span
        className={cn("field__message", error && "field__message--error")}
        id={messageId}
      >
        {error ?? hint ?? "\u00a0"}
      </span>
    </label>
  );
}

export interface SelectOption {
  label: string;
  value: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id">,
    FieldBaseProps {
  id?: string;
  options: readonly SelectOption[];
}

export function Select({
  className,
  error,
  hint,
  id: providedId,
  label,
  options,
  ...props
}: SelectProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const messageId = `${id}-message`;
  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">{label}</span>
      <span className="field__control-wrap">
        <select
          aria-describedby={error || hint ? messageId : undefined}
          aria-invalid={Boolean(error)}
          className={cn("field__control", className)}
          id={id}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon className="field__chevron" name="chevronDown" />
      </span>
      <span
        className={cn("field__message", error && "field__message--error")}
        id={messageId}
      >
        {error ?? hint ?? "\u00a0"}
      </span>
    </label>
  );
}

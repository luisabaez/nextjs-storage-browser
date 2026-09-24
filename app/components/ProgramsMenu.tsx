'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

export interface ProgramLink {
  href: string;
  label: string;
  icon?: string;
  title?: string;
}

interface ProgramsMenuProps {
  programs: ProgramLink[];
}

/** The other programs behind one header button, so the bar stays on one line. */
export function ProgramsMenu({ programs }: ProgramsMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (programs.length === 0) return null;

  return (
    <div
      className="programs-menu"
      ref={root}
      onBlur={e => {
        // Tabbing out of the menu closes it.
        if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className="admin-link programs-menu-button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span>Programs</span>
        <span className="programs-menu-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="programs-menu-list">
          {programs.map(p => (
            <li key={p.href}>
              <Link href={p.href} title={p.title} onClick={() => setOpen(false)}>
                <span className="programs-menu-icon" aria-hidden="true">{p.icon}</span>
                <span>{p.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

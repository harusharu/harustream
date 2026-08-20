'use client';

import { Bug, Scale } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { VIEWPORT, viewFadeUp } from '@/components/motion';

const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME || 'harustream';
const GITHUB_URL = 'https://github.com/harusharu/harustream';
const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
const COPYRIGHT_YEAR = new Date().getFullYear();

const PROJECT_LINKS: { label: string; href: string; icon: ReactNode }[] = [
  { label: 'GitHub repository', href: GITHUB_URL, icon: <GithubIcon /> },
  {
    label: 'Report an issue',
    href: `${GITHUB_URL}/issues`,
    icon: <Bug className="size-3.5" aria-hidden="true" />,
  },
  {
    label: 'License (AGPL-3.0)',
    href: LICENSE_URL,
    icon: <Scale className="size-3.5" aria-hidden="true" />,
  },
];

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className ?? 'size-3.5'}
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

const linkClass =
  'touch-target inline-flex min-w-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-200 hover:bg-secondary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden';

export function Footer() {
  return (
    <motion.footer
      variants={viewFadeUp}
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
      className="mt-10 border-t border-border/60 sm:mt-12"
    >
      {/* Compact footer. Project links are centered in a single row so the
        whole footer stays just two rows tall. */}
      <div className="px-4 py-4 text-center sm:px-6 md:py-5">
        <nav aria-label="Project" className="flex flex-wrap items-center justify-center gap-1.5">
          {PROJECT_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              <span className="shrink-0">{link.icon}</span>
              <span className="truncate">{link.label}</span>
            </a>
          ))}
        </nav>
      </div>

      <div className="border-t border-border/40 py-3 text-center text-xs leading-relaxed text-muted-foreground">
        <p className="whitespace-nowrap px-4">
          © {COPYRIGHT_YEAR} {SITE_NAME}. Free software under{' '}
          <a
            href={LICENSE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm font-medium text-primary underline-offset-4 transition hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
          >
            GNU AGPL v3.0
          </a>{' '}
          — all content streams from third-party providers; {SITE_NAME} doesn't host or own any
          titles.
        </p>
      </div>
    </motion.footer>
  );
}

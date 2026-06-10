// sort-imports-ignore
import type { Metadata, Viewport } from 'next';
import { Geist } from 'next/font/google';
import localFont from 'next/font/local';

import './globals.css';
import { WorkerPoolContext } from './_components/WorkerPoolContext';
import { PreloadHighlighter } from '@/components/PreloadHighlighter';
import { ScrollbarGutterVariables } from '@/components/ScrollbarGutterVariables';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/site';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const berkeleyMono = localFont({
  src: './BerkeleyMonoVariable.woff2',
  variable: '--font-berkeley-mono',
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  userScalable: false,
  maximumScale: 1,
  viewportFit: 'cover',
  // diffshub body uses --diffshub-sidebar-bg (#f7f7f7 / #101010) rather than
  // the plain neutral background, so it gets its own theme-color pair for the
  // browser chrome address bar.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f7' },
    { media: '(prefers-color-scheme: dark)', color: '#101010' },
  ],
};

// When running in a worktree, prefix the title with a stable emoji + slug so
// browser tabs for different worktrees are distinguishable at a glance. The
// slug reaches this file via `next.config.mjs`, which loads `.env.worktree`
// and bridges `PIERRE_WORKTREE_SLUG` into `NEXT_PUBLIC_WORKTREE_SLUG`. No-op
// in the main clone.
const WORKTREE_EMOJI_PALETTE = [
  '🟢',
  '🔵',
  '🟡',
  '🟠',
  '🟣',
  '🔴',
  '🟤',
  '⚪',
] as const;

function worktreeTitlePrefix(): string {
  const slug = process.env.NEXT_PUBLIC_WORKTREE_SLUG;
  if (!slug) return '';
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  const emoji = WORKTREE_EMOJI_PALETTE[hash % WORKTREE_EMOJI_PALETTE.length];
  return `${emoji} [${slug}] `;
}

const WORKTREE_PREFIX = worktreeTitlePrefix();

// The app only ever runs on localhost, so metadataBase always points there.
const SITE_PORT = process.env.PORT ?? '3693';
const SITE_ORIGIN = `http://localhost:${SITE_PORT}`;
const taggedTitle = `${WORKTREE_PREFIX}${SITE_NAME}`;
const description = SITE_DESCRIPTION;
const SITE_ICONS: Metadata['icons'] = {
  icon: [
    { url: '/diffshub-brand/icon.svg', type: 'image/svg+xml' },
    { url: '/diffshub-brand/icon.ico', sizes: '32x32' },
  ],
  apple: '/diffshub-brand/apple-icon.png',
};
const themeBootstrapScript = `(${String(function applyInitialTheme() {
  try {
    const storedTheme = window.localStorage.getItem('theme');
    const theme =
      storedTheme === 'light' || storedTheme === 'dark'
        ? storedTheme
        : 'system';
    const resolvedTheme =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
    const root = document.documentElement;

    root.classList.remove('light', 'dark');
    root.classList.add(resolvedTheme);
    root.style.colorScheme = resolvedTheme;

    // Set the iOS navbar tint before first paint so it matches the resolved
    // mode immediately. The meta is created here (not authored in JSX, which
    // React 19 would hoist into a duplicate) and owned by JS thereafter.
    // Literals mirror MODE_THEME_COLOR in theme-provider.tsx (this stringified
    // script can't import it); keep them in sync.
    let themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta == null) {
      themeColorMeta = document.createElement('meta');
      themeColorMeta.setAttribute('name', 'theme-color');
      document.head.appendChild(themeColorMeta);
    }
    themeColorMeta.setAttribute(
      'content',
      resolvedTheme === 'dark' ? '#0a0a0a' : '#ffffff'
    );
  } catch {
    // Ignore storage/media failures and let CSS defaults apply.
  }
})})()`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: taggedTitle,
    template: `${WORKTREE_PREFIX}%s`,
  },
  description,
  icons: SITE_ICONS,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${berkeleyMono.variable} ${geistSans.variable}`}
    >
      <head>
        {/* The iOS navbar tint <meta name="theme-color"> is created and
            managed entirely by the bootstrap script below (and ThemeProvider),
            not authored here — React 19 hoists head tags and would leave a
            duplicate it manages alongside ours. */}
        <script
          id="docs-theme-bootstrap"
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
        />
      </head>
      <body className="diffshub">
        <ScrollbarGutterVariables />
        <WorkerPoolContext>
          <ThemeProvider attribute="class">
            {children}
            <Toaster />
            <div
              id="dark-mode-portal-container"
              className="dark"
              data-theme="dark"
            ></div>
            <div
              id="light-mode-portal-container"
              className="light"
              data-theme="light"
            ></div>
          </ThemeProvider>
        </WorkerPoolContext>
        <PreloadHighlighter />
      </body>
    </html>
  );
}

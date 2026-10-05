/**
 * PUBLIC "ABOUT MOVABI" PAGE.
 *
 * The About page is general-public marketing content: it must open for
 * signed-out, signed-in and pending-registration visitors, with no login,
 * registration or role-selection redirect, and must not depend on
 * authenticated/private API data. Protected application routes must remain
 * guarded.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const ROUTES = read('src/app/apps/mobile/mobile.routes.ts');
const ADMIN_ROUTES = read('src/app/apps/admin/admin-web.routes.ts');
const ABOUT = read('src/app/apps/admin/features/landing/movabi-about.component.ts');
const LANDING = read('src/app/apps/mobile/features/landing.page.ts');
const ADMIN_LAYOUT = read('src/app/apps/admin/features/layout/admin-layout.component.ts');
const NGINX = read('docker/frontend/default.conf');

/** The public `/about-movabi` route block from the mobile/web route table. */
const aboutRouteBlock = () => {
  const start = ROUTES.indexOf("path: 'about-movabi'");
  return ROUTES.slice(start, ROUTES.indexOf('path:', start + 10));
};

describe('Public About route', () => {
  it('is registered in the public mobile/web route table', () => {
    expect(ROUTES).toContain("path: 'about-movabi'");
    expect(aboutRouteBlock()).toContain('AdminMovabiAboutComponent');
  });

  it('has NO authentication, registration or role guard', () => {
    expect(aboutRouteBlock()).not.toContain('canActivate');
    expect(aboutRouteBlock()).not.toContain('authGuard');
    expect(aboutRouteBlock()).not.toContain('registrationGuard');
    expect(aboutRouteBlock()).not.toContain('roleGuard');
  });

  it('is declared before any catch-all route', () => {
    expect(ROUTES).not.toContain("path: '**'");
  });
});

describe('About component never redirects or re-gates the visitor', () => {
  it('does not call handlePostAuthRedirect', () => {
    expect(ABOUT).not.toContain('handlePostAuthRedirect');
  });

  it('has no auth dependency (no AuthService/currentUser/OnInit redirect)', () => {
    expect(ABOUT).not.toContain('AuthService');
    expect(ABOUT).not.toContain('currentUser');
    expect(ABOUT).not.toContain('implements OnInit');
    expect(ABOUT).not.toContain('ngOnInit');
  });

  it('performs no router navigation of its own', () => {
    expect(ABOUT).not.toMatch(/this\.router\.navigate/);
  });

  it('depends on no authenticated/private API data', () => {
    expect(ABOUT).not.toMatch(/supabase|profileService|HttpClient|fetch\(|\/api\//i);
  });

  it('preserves the existing public marketing content', () => {
    expect(ABOUT).toContain('LOCAL TRANSPORT MADE SIMPLER');
    expect(ABOUT).toContain('Your everyday move, made simple.');
    expect(ABOUT).toContain('Rides, errands, deliveries and moving — all in one app.');
    expect(ABOUT).toContain('Explore services');
    expect(ABOUT).toContain('Become a driver');
    expect(ABOUT).toContain('Available services vary by location.');
    expect(ABOUT).toContain('Ride, errand, delivery and moving');
    expect(ABOUT).toContain('Why Movabi');
    expect(ABOUT).toContain('Investors');
    expect(ABOUT).toContain('Download');
  });
});

describe('About links target the public route', () => {
  it('landing footer links to /about-movabi', () => {
    expect(LANDING).toContain('routerLink="/about-movabi"');
    expect(LANDING).toContain('About Movabi');
  });

  it('admin navigation uses the absolute public path', () => {
    expect(ADMIN_LAYOUT).toContain("path: '/about-movabi'");
  });

  it('links never point at a guarded/relative variant', () => {
    expect(LANDING).not.toContain('routerLink="/admin/about-movabi"');
    expect(ADMIN_LAYOUT).not.toContain("path: 'about-movabi'");
  });
});

describe('Same-page section navigation', () => {
  const SECTION_IDS = ['why', 'services', 'drivers', 'investors', 'download'];

  it('every nav target section exists in the page', () => {
    for (const id of SECTION_IDS) {
      expect(ABOUT, `missing section #${id}`).toContain(`id="${id}"`);
    }
  });

  it('every section link carries its real /about-movabi#id destination', () => {
    const sectionLinks = [...ABOUT.matchAll(/<a href="\/about-movabi#([a-z]+)"([^>]*)>/g)];
    expect(sectionLinks.length, 'expected desktop + mobile section links').toBeGreaterThanOrEqual(10);

    for (const [, id, attrs] of sectionLinks) {
      expect(SECTION_IDS, `unexpected fragment target #${id}`).toContain(id);
      expect(attrs, `#${id} link is not wired to onSectionLink`).toContain('onSectionLink($event');
    }
  });

  it('no bare fragment href remains (it would resolve to /#id under <base href="/">)', () => {
    expect(ABOUT).not.toMatch(/<a href="#[a-z]+"/);
    expect(ABOUT).not.toMatch(/<ion-button[^>]*href="#[a-z]+"/);
  });

  it('mobile menu section links close the menu', () => {
    const start = ABOUT.indexOf('class="mobile-menu"');
    const mobileMenu = ABOUT.slice(start, ABOUT.indexOf('</nav>', start));

    for (const id of SECTION_IDS) {
      expect(mobileMenu).toContain(`onSectionLink($event, '${id}', { closeMenu: true })`);
    }
  });

  it('the handler intercepts only plain primary clicks', () => {
    expect(ABOUT).toContain('onSectionLink(event: MouseEvent, id: string, options?: { closeMenu?: boolean }): void');
    expect(ABOUT).toContain('event.button !== 0');
    expect(ABOUT).toContain('event.metaKey');
    expect(ABOUT).toContain('event.ctrlKey');
    expect(ABOUT).toContain('event.shiftKey');
    expect(ABOUT).toContain('if (isModifiedOrNonPrimary) return;');
    expect(ABOUT).toContain('event.preventDefault();');
    expect(ABOUT).toContain("target.scrollIntoView({ behavior: 'smooth', block: 'start' });");
  });

  it('lands on the fragment after rendering for direct entry / new-tab opens', () => {
    expect(ABOUT).toContain('afterNextRender(');
    expect(ABOUT).toContain('this.route.snapshot.fragment');
    expect(ABOUT).toContain('private route = inject(ActivatedRoute);');
  });

  it('sections clear the sticky header when scrolled into view', () => {
    expect(ABOUT).toContain('scroll-margin-top: 88px;');
  });
});

describe('Protected application routes stay locked down', () => {
  it('role selection requires auth + registration activation', () => {
    expect(ROUTES).toContain('canActivate: [authGuard, registrationGuard]');
  });

  it('customer and driver shells require auth + registration + role', () => {
    expect(ROUTES).toContain('canActivate: [authGuard, registrationGuard, roleGuard]');
  });

  it('the admin shell still requires admin auth + role', () => {
    expect(ADMIN_ROUTES).toContain('canActivate: [authGuard, roleGuard]');
    expect(ADMIN_ROUTES).toContain("data: { role: 'admin' }");
  });

  it('guards were not globally weakened', () => {
    expect(ROUTES).toContain("import { authGuard } from '@core/guards/auth.guard';");
    expect(ROUTES).toContain("import { registrationGuard } from '@core/guards/registration.guard';");
    expect(ROUTES).toContain("import { roleGuard } from '@core/guards/role.guard';");
  });
});

describe('Direct URL entry / refresh', () => {
  it('the frontend host serves index.html for unknown deep paths (SPA fallback)', () => {
    expect(NGINX).toContain('try_files $uri $uri/ /index.html;');
  });

  it('the About page is lazy-loaded (its own chunk resolves on direct entry)', () => {
    expect(aboutRouteBlock()).toContain("import('@admin/features/landing/movabi-about.component')");
  });
});

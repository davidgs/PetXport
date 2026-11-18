import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { Demo } from '../components/Demo';
import { ThemeToggle } from '../components/ThemeToggle';
import { VisitConsent } from '../components/VisitConsent';
import { useVisitorCounter } from '../lib/analytics';
import { useMe } from '../lib/api';
import { CONTACT_EMAIL, LegalLinks } from './Legal';

/**
 * The public pages: what PetXport is, what it does, and how to use it.
 * They describe the app as it actually behaves; when a feature changes, change the words here too.
 */

const ASK_TO_JOIN = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('PetXport for our rescue')}`;

const primary = 'inline-flex items-center justify-center rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-800';
const secondary = 'inline-flex items-center justify-center rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50';
const textLink = 'font-medium text-brand-700 hover:underline';

function useTitle(title: string) {
  useEffect(() => {
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);
}

/** Jumps to the top on a new page, or to the section named after "#". */
function useScrollToHash() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const target = hash ? document.getElementById(hash.slice(1)) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash]);
}

function SiteShell({ children }: { children: ReactNode }) {
  useScrollToHash();
  useVisitorCounter();
  const signedIn = Boolean(useMe().data);
  const nav = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-2.5 py-1.5 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-900' : 'text-slate-600 hover:bg-slate-100'}`;
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-1 px-4 py-2.5">
          <Link to="/" className="mr-auto flex items-center gap-2">
            <img src="/icon.svg" alt="" className="h-8 w-8" />
            <span className="text-lg font-semibold tracking-tight text-brand-900">PetXport</span>
          </Link>
          <nav className="flex items-center gap-0.5" aria-label="Site">
            <NavLink to="/features" className={nav}>
              Features
            </NavLink>
            <NavLink to="/how-it-works" className={nav}>
              <span className="sm:hidden">Guide</span>
              <span className="hidden sm:inline">How it works</span>
            </NavLink>
          </nav>
          <ThemeToggle className="hidden text-slate-500 hover:bg-slate-100 sm:block" />
          <Link to={signedIn ? '/app' : '/login'} className={`${primary} ml-1 whitespace-nowrap !px-3 !py-1.5`}>
            {signedIn ? 'Open the app' : 'Log in'}
          </Link>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-3 px-4 py-8 text-sm text-slate-600 sm:flex-row sm:justify-between">
          <div className="flex items-center gap-2">
            <img src="/icon.svg" alt="" className="h-6 w-6" />
            <span>PetXport: volunteer pet transport, leg by leg.</span>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1" aria-label="Footer">
            <Link to="/features" className="hover:underline">
              Features
            </Link>
            <Link to="/how-it-works" className="hover:underline">
              How it works
            </Link>
            <a href={`mailto:${CONTACT_EMAIL}`} className="hover:underline">
              Contact
            </a>
            <Link to={signedIn ? '/app' : '/login'} className="hover:underline">
              {signedIn ? 'Open the app' : 'Log in'}
            </Link>
            <ThemeToggle className="text-slate-500 hover:bg-slate-100" />
          </nav>
        </div>
        <LegalLinks className="pb-6 text-center" />
      </footer>
      <VisitConsent />
    </div>
  );
}

const Section = ({ id, className = '', children }: { id?: string; className?: string; children: ReactNode }) => (
  <section id={id} className={`mx-auto max-w-5xl scroll-mt-20 px-4 py-12 sm:py-16 ${className}`}>
    {children}
  </section>
);

const Eyebrow = ({ children }: { children: ReactNode }) => <p className="text-xs font-semibold uppercase tracking-wider text-brand-700">{children}</p>;
const H2 = ({ children }: { children: ReactNode }) => <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{children}</h2>;

/** Small line drawings, so the pages need no image files. */
const icons = {
  people: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.500V19M10 10.500a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM20 19v-1.500a3.500 3.500 0 0 0-2.500-3.350M15.500 4.700a3 3 0 0 1 0 5.600',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 17h5.500a3 3 0 0 0 0-6h-3a3 3 0 0 1 0-6H16',
  pin: 'M12 21s7-6.200 7-11.500A7 7 0 0 0 5 9.500C5 14.800 12 21 12 21ZM12 12a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5Z',
  hand: 'M12 21c-4 0-7-2.500-7-7V8.500a1.500 1.500 0 0 1 3 0V12M8 12V5.500a1.500 1.500 0 0 1 3 0V11M11 11V4.500a1.500 1.500 0 0 1 3 0V11M14 11V6.500a1.500 1.500 0 0 1 3 0V14c0 4-2 7-5 7',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.500 2h-15L6 16ZM10 20a2 2 0 0 0 4 0',
  chat: 'M20 12a8 8 0 0 1-11.600 7.100L4 20l1-4.200A8 8 0 1 1 20 12Z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 18h2',
} as const;

function Icon({ name }: { name: keyof typeof icons }) {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={icons[name]} />
      </svg>
    </span>
  );
}

function FeatureCard({ icon, title, children }: { icon: keyof typeof icons; title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <Icon name={icon} />
      <h3 className="mt-3 font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-slate-600">{children}</p>
    </div>
  );
}

function JoinBand() {
  return (
    <Section>
      <div className="rounded-3xl bg-brand-700 px-6 py-10 text-center sm:px-10">
        <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Want PetXport for your rescue?</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-white/85">
          Rescues join by invitation. Write to us with your organization's name and we will set up your private area and send you a link to get
          started.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <a href={ASK_TO_JOIN} className="inline-flex items-center justify-center rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-teal-800 hover:bg-white/90">
            Ask to join
          </a>
          <Link to="/how-it-works" className="inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium text-white ring-1 ring-inset ring-white/50 hover:bg-white/10">
            Read the guide
          </Link>
        </div>
        <p className="mt-4 text-xs text-white/70">Already invited? Use the link in your invitation email, or log in.</p>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

export function Landing() {
  useTitle('PetXport: volunteer pet transport, leg by leg');
  return (
    <SiteShell>
      <Section className="!pb-6 text-center sm:!pt-20">
        <Eyebrow>For animal rescues and their volunteer drivers</Eyebrow>
        <h1 className="mx-auto mt-2 max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">Get every pet home, one leg at a time.</h1>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-slate-600 sm:text-lg">
          PetXport plans long-distance rescue transports as a relay. It splits the trip into short legs, helps you find a volunteer for each one,
          and keeps every driver in touch on the day.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <a href="#demo" className={primary}>
            Watch how it works
          </a>
          <a href={ASK_TO_JOIN} className={secondary}>
            Ask to join
          </a>
        </div>
      </Section>

      <Section id="demo" className="!pt-6">
        <div className="mx-auto max-w-4xl">
          <Demo />
        </div>
      </Section>

      <div className="border-y border-slate-200 bg-white">
        <Section>
          <div className="grid gap-8 sm:grid-cols-3">
            {[
              ['Instead of a spreadsheet', 'One place for the route, the legs, who is driving each one, and when and where they meet.'],
              ['Instead of a dozen group texts', 'Volunteers are asked, answer, and get their itinerary in the app. Everyone on a transport shares one chat.'],
              ['Instead of guessing the meeting spot', 'Pick a real gas station, rest area or parking lot on the map, and every driver sees exactly where to go.'],
            ].map(([title, text]) => (
              <div key={title}>
                <h3 className="font-semibold text-slate-900">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{text}</p>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <Section>
        <Eyebrow>What it does</Eyebrow>
        <H2>Everything a transport needs, start to finish</H2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard icon="people" title="Your driver list">
            Keep each volunteer's contact details, home area, how far they will drive, and what size of animal they can carry.
          </FeatureCard>
          <FeatureCard icon="route" title="Legs worked out for you">
            Enter the start and the destination. The route is split into even legs of about 100 miles or two hours, with a schedule.
          </FeatureCard>
          <FeatureCard icon="pin" title="Real hand-off places">
            Zoom in on the map and choose a gas station, rest area, hotel or restaurant for each hand-off.
          </FeatureCard>
          <FeatureCard icon="hand" title="Ask for volunteers">
            See which drivers live near each leg, send the request, and confirm who drives from the offers that come back.
          </FeatureCard>
          <FeatureCard icon="bell" title="Itinerary and reminders">
            Drivers see who they receive from and hand off to, with times and phone numbers, and get a reminder before they leave.
          </FeatureCard>
          <FeatureCard icon="chat" title="One chat per transport">
            Coordinators and that day's drivers talk in one place, live, instead of across separate text threads.
          </FeatureCard>
        </div>
        <p className="mt-6 text-sm">
          <Link to="/features" className={textLink}>
            See all the features →
          </Link>
        </p>
      </Section>

      <div className="border-y border-slate-200 bg-white">
        <Section>
          <div className="grid gap-10 sm:grid-cols-2">
            <div>
              <Eyebrow>For coordinators</Eyebrow>
              <H2>Plan in minutes, not evenings</H2>
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-slate-600">
                <li>• Invite drivers by pasting their email addresses, or import your existing list.</li>
                <li>• See at a glance which legs still need a driver.</li>
                <li>• Move a hand-off and the schedule recalculates itself.</li>
                <li>• Print the finished itinerary, or let everyone read it on their phone.</li>
              </ul>
              <p className="mt-4 text-sm">
                <Link to="/how-it-works#coordinators" className={textLink}>
                  Coordinator guide →
                </Link>
              </p>
            </div>
            <div>
              <Eyebrow>For volunteer drivers</Eyebrow>
              <H2>Know exactly where to be</H2>
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-slate-600">
                <li>• Nothing to install: it works in the browser on any phone, and can be added to your home screen.</li>
                <li>• Offer to take a leg with one tap.</li>
                <li>• See your leg on a map and open it in Google Maps or Apple Maps for directions.</li>
                <li>• Pause requests whenever you are not available.</li>
              </ul>
              <p className="mt-4 text-sm">
                <Link to="/how-it-works#drivers" className={textLink}>
                  Driver guide →
                </Link>
              </p>
            </div>
          </div>
        </Section>
      </div>

      <Section>
        <div className="grid gap-4 sm:grid-cols-2">
          <FeatureCard icon="lock" title="Private to your rescue">
            Each organization has its own area. Your drivers, transports and messages cannot be seen by any other rescue, even when a volunteer
            helps more than one.
          </FeatureCard>
          <FeatureCard icon="phone" title="Phone, tablet or computer">
            The same site works everywhere, in light or dark mode, with your rescue's own logo at the top.
          </FeatureCard>
        </div>
      </Section>

      <JoinBand />
    </SiteShell>
  );
}

// ---------------------------------------------------------------------------------------------

function FeatureGroup({ id, eyebrow, title, items }: { id: string; eyebrow: string; title: string; items: [string, string][] }) {
  return (
    <Section id={id} className="!py-8">
      <Eyebrow>{eyebrow}</Eyebrow>
      <H2>{title}</H2>
      <dl className="mt-6 grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {items.map(([name, text]) => (
          <div key={name} className="border-l-2 border-brand-200 pl-4">
            <dt className="font-semibold text-slate-900">{name}</dt>
            <dd className="mt-0.5 text-sm leading-relaxed text-slate-600">{text}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function Features() {
  useTitle('Features · PetXport');
  return (
    <SiteShell>
      <Section className="!pb-2">
        <Eyebrow>Features</Eyebrow>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">What PetXport does</h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-600">
          Built around the way rescue relays actually run: a coordinator plans, volunteers each drive a couple of hours, and the animal changes
          cars at an agreed place.
        </p>
      </Section>

      <FeatureGroup
        id="planning"
        eyebrow="Planning"
        title="From two addresses to a full relay"
        items={[
          ['Automatic legs', 'Give the pickup place, the destination and the leaving time. The driving route is split into even legs, so no one is left with a short stub at the end.'],
          ['Your own leg length', 'Legs aim for 100 miles or two hours by default. Each rescue can set its own length and how long to allow for each hand-off.'],
          ['A schedule that keeps up', 'Every leg gets a leaving and arriving time. Change the start time or move a hand-off and the rest is recalculated.'],
          ['Hand-off places you choose', 'Each hand-off starts at a sensible point on the route. Zoom in and pick a real gas station, rest area, hotel, restaurant or shopping center instead.'],
          ['Who is travelling', 'Record each animal on the transport: name, breed, size and notes the drivers should know.'],
          ['Notes for drivers', 'Add instructions that everyone on the transport sees with their itinerary.'],
        ]}
      />

      <FeatureGroup
        id="volunteers"
        eyebrow="Volunteers"
        title="Your drivers, and finding the right one"
        items={[
          ['Driver list', 'Phone number, home area, how far each person will drive, usual availability, vehicle, crate capacity and the largest animal they can take.'],
          ['Easy invitations', 'Paste a list of email addresses, add people one at a time, or import a spreadsheet saved as CSV. Each person gets a link to set up their own account.'],
          ['Suggested drivers', 'For each open leg, PetXport shows which active drivers live within their own driving range of it.'],
          ['Requests and offers', 'Send a request to the drivers you choose. They offer to take a leg with one tap, and you confirm one. You can also assign a driver directly.'],
          ['Drivers stay in control', 'A volunteer can pause requests without leaving the team, and withdraw an offer if their plans change.'],
          ['Coordinator notes', 'Keep private notes about a driver that only coordinators can see.'],
        ]}
      />

      <FeatureGroup
        id="on-the-day"
        eyebrow="On the day"
        title="Everyone knows where to be"
        items={[
          ['A personal itinerary', 'Each driver sees their leg, who they receive the animal from and who they hand off to, with times, places and phone numbers.'],
          ['The route on a map', 'The whole trip is drawn on a map with the hand-offs numbered. Drivers can show their own position on it.'],
          ['Turn-by-turn directions', 'One tap opens a leg in Google Maps or Apple Maps.'],
          ['Progress as it happens', 'Drivers mark when they are on the road and when their leg is done, so the coordinator can follow the relay.'],
          ['One chat per transport', 'Coordinators and that transport\'s drivers share a live conversation, with unread counts.'],
          ['Printable itinerary', 'Print the full plan for anyone who prefers paper.'],
        ]}
      />

      <FeatureGroup
        id="notifications"
        eyebrow="Staying informed"
        title="The right notice at the right time"
        items={[
          ['Email', 'Requests, confirmations, schedule changes and new chat messages arrive by email.'],
          ['Push notifications', 'Turn on notifications in a desktop or Android browser, or on an iPhone or iPad after adding PetXport to the home screen.'],
          ['Reminders', 'Assigned drivers are reminded the day before their leg and again about two hours before it.'],
          ['Each person chooses', 'Every volunteer picks which kinds of notice they get, on their own profile.'],
        ]}
      />

      <FeatureGroup
        id="security"
        eyebrow="Privacy and security"
        title="Your rescue's information stays yours"
        items={[
          ['A private area for each rescue', 'Organizations are separated inside the database itself, not only on screen. One rescue can never see another\'s drivers, transports or messages.'],
          ['Three kinds of member', 'Admins run the organization, coordinators manage drivers and transports, and drivers see only the transports they are part of.'],
          ['Two-step sign-in', 'Anyone can add a second step: a six-digit code sent by email each time they log in.'],
          ['Passkeys', 'Log in with a fingerprint, face or device PIN instead of typing a password.'],
          ['No advertising, no tracking inside the app', 'PetXport shows no ads. A visitor counter runs on these public pages only; it is never loaded once you log in.'],
          ['Your own look', 'Upload your rescue\'s logo, and choose light or dark mode.'],
        ]}
      />

      <JoinBand />
    </SiteShell>
  );
}

// ---------------------------------------------------------------------------------------------

function Steps({ items }: { items: [string, ReactNode][] }) {
  return (
    <ol className="mt-6 space-y-5">
      {items.map(([title, body], i) => (
        <li key={title} className="flex gap-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-700 text-sm font-semibold text-white">{i + 1}</span>
          <div className="min-w-0">
            <h3 className="font-semibold text-slate-900">{title}</h3>
            <div className="mt-1 space-y-2 text-sm leading-relaxed text-slate-600">{body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Words that appear on a button or menu in the app. */
const B = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-slate-800">{children}</strong>;

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200">
      <summary className="cursor-pointer list-none font-medium text-slate-900 marker:hidden">
        <span className="mr-2 inline-block text-brand-700 transition-transform group-open:rotate-90 motion-reduce:transition-none">›</span>
        {q}
      </summary>
      <div className="mt-2 space-y-2 pl-5 text-sm leading-relaxed text-slate-600">{children}</div>
    </details>
  );
}

export function Guide() {
  useTitle('How it works · PetXport');
  const toc: [string, string][] = [
    ['start', 'Getting started'],
    ['coordinators', 'For coordinators'],
    ['drivers', 'For drivers'],
    ['roles', 'Who can do what'],
    ['questions', 'Common questions'],
  ];
  return (
    <SiteShell>
      <Section className="!pb-2">
        <Eyebrow>Guide</Eyebrow>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">How PetXport works</h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-600">
          A walk through setting up a rescue, planning a transport, and driving a leg. Words in <B>bold</B> are what you will see on the screen.
        </p>
        <nav className="mt-5 flex flex-wrap gap-2" aria-label="On this page">
          {toc.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
              {label}
            </a>
          ))}
        </nav>
      </Section>

      <Section id="start" className="!py-8">
        <H2>Getting started</H2>
        <Steps
          items={[
            [
              'Ask for your rescue to be added',
              <p>
                Rescues join by invitation.{' '}
                <a href={ASK_TO_JOIN} className={textLink}>
                  Write to us
                </a>{' '}
                with your organization's name. You will get an email with a link.
              </p>,
            ],
            [
              'Open the link and set up your account',
              <p>Choose a password and give your phone number. You become the admin of your rescue's private area, at its own web address.</p>,
            ],
            [
              'Make it yours',
              <p>
                Under <B>Settings</B>, upload your logo, check the time zone, and set your usual leg length and how many minutes to allow for each
                hand-off. Invite the other people who coordinate transports with you.
              </p>,
            ],
          ]}
        />
      </Section>

      <div className="border-y border-slate-200 bg-white">
        <Section id="coordinators" className="!py-10">
          <Eyebrow>For coordinators</Eyebrow>
          <H2>Planning a transport</H2>
          <Steps
            items={[
              [
                'Build your driver list',
                <>
                  <p>
                    On <B>Drivers</B>, choose <B>Invite drivers</B> and paste email addresses, one per line or separated by commas. You can also add
                    someone with their details, or import a CSV file.
                  </p>
                  <p>Each person gets an email link to create their account and fill in their own profile. Until they do, they show as "Invited".</p>
                </>,
              ],
              [
                'Create the transport',
                <p>
                  Choose <B>New transport</B>. Give it a name, search for the <B>Pickup place</B> and the <B>Destination</B>, set when it leaves, and
                  add the animals under <B>Who is travelling</B>. PetXport finds the route and splits it into legs.
                </p>,
              ],
              [
                'Check the hand-offs',
                <p>
                  Each hand-off starts at an even point along the route. Open one, zoom in on the map, and pick a real place to meet: a gas station,
                  rest area, hotel, restaurant or shopping center. The legs on either side and the schedule update to match.
                </p>,
              ],
              [
                'Ask for drivers',
                <p>
                  Choose <B>Request volunteers</B>. For each open leg you see which drivers are <B>In range</B>. Pick who to ask and send. They are
                  told by email and by push notification if they have it turned on.
                </p>,
              ],
              [
                'Confirm who drives',
                <p>
                  Offers appear on each leg as they come in. Confirm one, and the others are told that leg is taken. You can also assign a driver
                  yourself. When every leg has a driver, the transport is scheduled and everyone receives the itinerary.
                </p>,
              ],
              [
                'Follow along on the day',
                <p>
                  Drivers are reminded the day before and about two hours before their leg. Watch legs change to <B>On the road</B> and <B>Done</B>,
                  and use the transport's chat to reach everyone at once.
                </p>,
              ],
            ]}
          />
        </Section>
      </div>

      <Section id="drivers" className="!py-10">
        <Eyebrow>For volunteer drivers</Eyebrow>
        <H2>Driving a leg</H2>
        <Steps
          items={[
            [
              'Accept your invitation',
              <p>Open the link in the email from your rescue, choose a password and give your phone number. There is nothing to install.</p>,
            ],
            [
              'Fill in your profile',
              <p>
                Add your home address, how far you are willing to drive, your vehicle and what size of animal you can carry. This is how
                coordinators know which legs to ask you about.
              </p>,
            ],
            [
              'Turn on notifications',
              <>
                <p>On your profile, choose how to hear about transports: email, push notifications, or both.</p>
                <p>
                  On an iPhone or iPad, first add PetXport to your home screen: in Safari tap the Share button, then "Add to Home Screen". Open it
                  from there and turn notifications on.
                </p>
              </>,
            ],
            [
              'Offer to take a leg',
              <p>
                When a rescue needs drivers you get a notice, and open requests show on your home page. Look at the leg's start, finish and time,
                and tap to offer. The coordinator confirms, and you are told either way.
              </p>,
            ],
            [
              'On the day',
              <p>
                <B>Your legs</B> shows where to be and when, who you <B>receive from</B> and who you <B>hand off to</B>, with their phone numbers.
                Open the leg in Google Maps or Apple Maps for directions. Mark it when you set off and when you have handed off. Once you have the animals you can tap <B>Share my location</B>, so the next driver can see how close you are.
              </p>,
            ],
            [
              'Keep in touch',
              <p>Every transport has a chat for its coordinators and drivers. Use it to say you are running late or to describe your car.</p>,
            ],
          ]}
        />
        <p className="mt-6 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
          Please do not use the app while driving. Pull over somewhere safe first.
        </p>
      </Section>

      <div className="border-y border-slate-200 bg-white">
        <Section id="roles" className="!py-10">
          <H2>Who can do what</H2>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-900">
                  <th className="py-2 pr-4 font-semibold"> </th>
                  <th className="px-2 py-2 font-semibold sm:px-3">Admin</th>
                  <th className="px-2 py-2 font-semibold sm:px-3">Coordinator</th>
                  <th className="px-2 py-2 font-semibold sm:px-3">Driver</th>
                </tr>
              </thead>
              <tbody className="text-slate-600">
                {(
                  [
                    ['Change settings, logo and who is on the team', true, false, false],
                    ['Add and invite drivers', true, true, false],
                    ['Create and plan transports', true, true, false],
                    ['Ask for volunteers and confirm drivers', true, true, false],
                    ['See the whole driver list', true, true, false],
                    ['Offer to drive a leg', true, true, true],
                    ['See and chat on transports they are part of', true, true, true],
                    ['Edit their own profile and notifications', true, true, true],
                  ] as [string, boolean, boolean, boolean][]
                ).map(([what, ...who]) => (
                  <tr key={what} className="border-b border-slate-100">
                    <td className="py-2 pr-4">{what}</td>
                    {who.map((yes, i) => (
                      <td key={i} className="px-2 py-2 sm:px-3">
                        {yes ? <span className="font-semibold text-emerald-700">Yes</span> : <span className="text-slate-400">No</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <Section id="questions" className="!py-10">
        <H2>Common questions</H2>
        <div className="mt-6 space-y-2">
          <Faq q="Do drivers need to install an app?">
            <p>No. PetXport is a website that works in the browser on any phone, tablet or computer. Adding it to the home screen makes it open like an app.</p>
          </Faq>
          <Faq q="Can someone volunteer for more than one rescue?">
            <p>Yes. One account can belong to several rescues, with a separate profile in each. The rescues cannot see each other's information.</p>
          </Faq>
          <Faq q="Who can see a driver's phone number and address?">
            <p>
              Coordinators and admins of that rescue can see the driver's profile. Other drivers see a name and phone number only for people on the same
              transport, so hand-offs can be arranged. Home addresses are not shown to other drivers.
            </p>
          </Faq>
          <Faq q="What if a driver has to cancel?">
            <p>The driver tells the coordinator, usually in the transport's chat. The coordinator can assign another driver to that leg or ask for volunteers again.</p>
          </Faq>
          <Faq q="How long is a leg?">
            <p>About 100 miles or two hours, whichever comes first, unless your rescue has chosen a different length in its settings.</p>
          </Faq>
          <Faq q="Does PetXport give directions?">
            <p>It shows the route and each leg on a map. For spoken turn-by-turn directions, one tap opens the leg in Google Maps or Apple Maps.</p>
          </Faq>
          <Faq q="Can we see where the pet is during a transport?">
            <p>
              Yes, when the driver chooses to share. After picking up, a driver can tap <B>Share my location</B>, and the coordinator and the other
              drivers on that transport see a paw on the map with how long ago it was updated. It only updates while PetXport is open on the
              driver's screen, only the latest position is kept, and it is deleted at the hand-off.
            </p>
          </Faq>
          <Faq q="Are the times and distances exact?">
            <p>They are estimates from public map data. Allow for traffic and weather, and check the meeting place yourself.</p>
          </Faq>
          <Faq q="I forgot my password.">
            <p>
              Use <Link to="/forgot" className={textLink}>Forgot your password?</Link> on the log in page and a reset link is emailed to you.
            </p>
          </Faq>
        </div>
        <p className="mt-6 text-sm text-slate-600">
          Something else? Write to{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className={textLink}>
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>

      <JoinBand />
    </SiteShell>
  );
}

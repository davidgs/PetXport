import { SMS_DISCLOSURE } from '@petxport/shared';
import { useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { ThemeToggle } from '../components/ThemeToggle';
import { VisitConsent } from '../components/VisitConsent';
import { counterApplies, setVisitChoice, useVisitChoice, useVisitorCounter } from '../lib/analytics';

/**
 * The facts both documents depend on. Change them here and both pages follow.
 * These pages describe what the software actually does; if that changes (a new outside
 * service, a new kind of text message, analytics), update the wording in the same change.
 */
const OPERATOR = 'PetXport';
const SITE = 'petxport.org';
export const CONTACT_EMAIL = 'support@petxport.org';
const GOVERNING_LAW = 'the State of North Carolina, United States';
const EFFECTIVE = 'November 17, 2026';

const link = 'font-medium text-brand-700 hover:underline';
const mail = (
  <a className={link} href={`mailto:${CONTACT_EMAIL}`}>
    {CONTACT_EMAIL}
  </a>
);

function LegalShell({ title, children }: { title: string; children: ReactNode }) {
  useVisitorCounter();
  // Arriving at a named section (for example from the visitor-count question) goes straight to it.
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [hash]);
  return (
    <div className="relative mx-auto min-h-full max-w-3xl px-4 py-10">
      <ThemeToggle className="absolute right-3 top-3 text-slate-500 hover:bg-slate-100" />
      <Link to="/" className="mb-6 flex items-center gap-2">
        <img src="/icon.svg" alt="" className="h-9 w-9" />
        <span className="text-xl font-semibold tracking-tight text-brand-900">PetXport</span>
      </Link>
      <article className="space-y-4 rounded-2xl bg-white p-6 text-sm leading-relaxed text-slate-700 shadow-sm ring-1 ring-slate-200 sm:p-8">
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        <p className="text-xs text-slate-500">Effective {EFFECTIVE}</p>
        {children}
      </article>
      <LegalLinks className="mt-6 text-center" />
      <VisitConsent />
    </div>
  );
}

/** The small "Privacy · Terms" line shown under sign-in pages and inside the app. */
export function LegalLinks({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-slate-500 ${className}`}>
      <Link to="/" className="hover:underline">
        PetXport home
      </Link>
      {' · '}
      <Link to="/privacy" className="hover:underline">
        Privacy Policy
      </Link>
      {' · '}
      <Link to="/terms" className="hover:underline">
        Terms and Conditions
      </Link>
    </p>
  );
}

const H = ({ id, children }: { id?: string; children: ReactNode }) => (
  <h2 id={id} className="scroll-mt-6 pt-3 text-base font-semibold text-slate-900">
    {children}
  </h2>
);

/** Lets a visitor see and change their answer about being counted. */
function VisitChoiceNote() {
  const choice = useVisitChoice();
  if (!counterApplies()) return null;
  return (
    <p>
      Your choice on this device: <strong>{choice === 'yes' ? 'visits are counted' : choice === 'no' ? 'visits are not counted' : 'not yet answered'}</strong>.{' '}
      {choice !== null && (
        <button type="button" onClick={() => setVisitChoice(null)} className={link}>
          Change it
        </button>
      )}
    </p>
  );
}
const UL = ({ children }: { children: ReactNode }) => <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;

export function Privacy() {
  return (
    <LegalShell title="Privacy Policy">
      <p>
        {OPERATOR} ("we", "us") runs {SITE}, a service that animal rescue organizations use to plan volunteer pet transports. This policy explains what
        information the service holds, who can see it, and the choices you have. Questions: {mail}.
      </p>

      <H>Who is responsible for your information</H>
      <p>
        Each rescue organization decides who it invites and what it records about its transports and volunteers. We operate the service for those
        organizations and are responsible for keeping it secure. Each organization's area is private: its drivers, transports and messages are not
        visible to other organizations.
      </p>

      <H>What we collect</H>
      <UL>
        <li>
          <strong>Account details:</strong> your name, email address, mobile number and password, and a picture of yourself if you choose to add
          one. The password is stored only as a one-way hash; we cannot read it.
        </li>
        <li>
          <strong>Your location, only if you share it:</strong> while you are driving a leg you can switch on location sharing. We then keep your
          latest position, nothing earlier, and delete it when you stop sharing or hand off. It is off unless you turn it on.
        </li>
        <li>
          <strong>Driver profile:</strong> phone number, home address and its map location, how far you are willing to drive, your availability, your
          vehicle and crate capacity, and your notification choices. Coordinators may also keep notes about a driver for their own organization.
        </li>
        <li>
          <strong>Transport information:</strong> pick-up, hand-off and drop-off places, dates and times, details of the animals, which driver has
          which leg, and offers to drive.
        </li>
        <li>
          <strong>Messages:</strong> what you write in a transport's chat.
        </li>
        <li>
          <strong>Sign-in and security records:</strong> a session cookie, passkey public keys if you add a passkey, one-time sign-in codes, and
          whether you agreed to text messages and when.
        </li>
        <li>
          <strong>Notification records:</strong> which notices were sent to you and by which channel, and your browser's push subscription if you
          turn push notifications on.
        </li>
        <li>
          <strong>Technical logs:</strong> your IP address, the pages requested and the time, kept to run and protect the service.
        </li>
      </UL>
      <p>
        If you use the "show my location" button on a map, your position is used by your own browser to draw the map. It is not sent to us or shared
        with anyone.
      </p>

      <H>How we use it</H>
      <UL>
        <li>To let coordinators plan transports, find volunteers for each leg, and build the itinerary.</li>
        <li>To show drivers their route, schedule and hand-off details, and let people on a transport talk to each other.</li>
        <li>To send the notifications you have chosen: email, push, and text messages if you opted in.</li>
        <li>To sign you in, keep accounts secure, and prevent abuse.</li>
      </UL>
      <p>
        We do not sell your information or show advertising. Our public pages (the home page, features, guide, and these policy pages) use a
        visitor counter if you agree to it, described under "Visitor statistics" below. It is not used on the log-in pages or anywhere inside the app.
      </p>

      <H>Who can see your information</H>
      <UL>
        <li>
          <strong>Coordinators and administrators</strong> of an organization you belong to can see your driver profile for that organization,
          and your picture if you added one.
        </li>
        <li>
          <strong>Other people on the same transport</strong> can see your name, picture and phone number, the leg you are driving, and what you write in that
          transport's chat, so hand-offs can be arranged. If you switch on location sharing during your leg, they and the coordinators can also see
          where you are until the hand-off.
        </li>
        <li>
          <strong>Other organizations</strong> cannot see anything about you, even if you volunteer for more than one.
        </li>
      </UL>

      <H>Services that help us run PetXport</H>
      <p>We share only what each of these needs to do its job:</p>
      <UL>
        <li>
          <strong>Brevo</strong> delivers our email and text messages, and receives your email address or mobile number and the message.
        </li>
        <li>
          <strong>Mapping and routing services</strong> (OpenRouteService, and OpenStreetMap-based services such as OSRM, Nominatim and Overpass)
          receive addresses and map coordinates to look up places and calculate routes. They are not told who the address belongs to.
        </li>
        <li>
          <strong>OpenFreeMap</strong> supplies map images directly to your browser, so it sees your IP address and the area of the map you view.
        </li>
        <li>
          <strong>Your browser's push service</strong> (run by Apple, Google or Mozilla) delivers push notifications if you turn them on.
        </li>
        <li>
          <strong>Our hosting provider</strong> runs the server the service and its database live on.
        </li>
        <li>
          <strong>Statcounter</strong> counts visits to our public pages, as described under "Visitor statistics" below.
        </li>
      </UL>
      <p>We may also disclose information when the law requires it, or to protect the safety of people or animals.</p>

      <H>Text messages</H>
      <p>
        Text messages are optional and separate from every other choice. If you opt in, we text you about transports you are part of (requests for
        drivers, schedule changes and reminders) and, if you choose text message codes for signing in, a code each time you log in. {SMS_DISCLOSURE}
      </p>
      <p>
        <strong>
          No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging opt-in data and
          consent are not shared with any third party
        </strong>
        , other than the service providers that deliver the messages on our behalf. You can also switch text messages off at any time on your
        profile. See the <Link to="/terms" className={link}>Terms and Conditions</Link> for the full text message terms.
      </p>

      <H id="visitor-statistics">Visitor statistics</H>
      <p>
        To see how many people visit and which pages they read, our public pages (the home page, features, guide, and these policy pages) ask
        whether your visit may be counted. Only if you say OK do they load a visitor counter from Statcounter; if you say no, or do not
        answer, nothing is loaded. When you have agreed and view one of those pages without being logged in, Statcounter receives your IP address, the
        page you viewed, the site you came from, and details of your browser and device, and it may set a cookie to tell new visitors from
        returning ones. We see the results as totals and visit logs; we do not use them to identify you or combine them with account
        information.
      </p>
      <p>
        The counter is never loaded on the log-in, sign-up or invitation pages, or anywhere inside the app, and it is not loaded at all while
        you are logged in. Statcounter handles what it receives under its own privacy policy at statcounter.com.
      </p>
      <VisitChoiceNote />

      <H>Cookies</H>
      <p>
        Inside the app we use one cookie, which keeps you signed in. Your light or dark display choice is saved in your browser. On the public
        pages, the visitor counter described above may set its own cookie, but only if you agreed to be counted. Your answer to that question
        is also saved in your browser. There are no advertising cookies.
      </p>

      <H>How long we keep it</H>
      <p>
        We keep your information while your account is open or while an organization you belong to needs its transport records. Sign-in sessions and
        one-time links and codes expire on their own. To have your account or profile deleted, ask your organization's coordinator or write to {mail}
        ; records of transports you took part in may be kept by the organization with your name removed.
      </p>

      <H>Security</H>
      <p>
        The service is encrypted in transit, passwords are hashed, each organization's records are separated inside the database itself, and you can
        add a second sign-in step or a passkey. No system is perfectly secure; tell us at once at {mail} if you think your account has been misused.
      </p>

      <H>Your choices</H>
      <UL>
        <li>See and correct your details on your profile and account pages.</li>
        <li>Choose which notifications you get, and switch any of them off.</li>
        <li>Ask us for a copy of your information, or for it to be corrected or deleted, by writing to {mail}.</li>
      </UL>

      <H>Children</H>
      <p>The service is for adults. It is not directed at anyone under 18, and we do not knowingly collect their information.</p>

      <H>Changes</H>
      <p>
        If this policy changes in a way that matters, we will post the new version here with a new date and tell account holders by email before it
        takes effect.
      </p>
    </LegalShell>
  );
}

export function Terms() {
  return (
    <LegalShell title="Terms and Conditions">
      <p>
        These terms cover your use of {SITE}, operated by {OPERATOR} ("we", "us"). By creating an account or using the service you agree to them. If
        you do not agree, do not use the service. Questions: {mail}.
      </p>

      <H>What the service is</H>
      <p>
        PetXport is a planning and communication tool. Rescue organizations use it to keep a list of volunteer drivers, split a transport into legs,
        ask for volunteers, and share the itinerary. We provide the software. We do not arrange, supervise or carry out transports, and we are not a
        party to any arrangement between an organization and its volunteers.
      </p>

      <H>Accounts</H>
      <UL>
        <li>You must be at least 18 and give accurate information, including a phone number you can be reached on.</li>
        <li>Keep your password and sign-in codes to yourself. You are responsible for what happens under your account.</li>
        <li>Tell us promptly if you think someone else has used your account.</li>
      </UL>

      <H>Organizations</H>
      <p>
        An organization's administrators and coordinators decide who is invited, what is recorded, and who drives. They are responsible for having
        the right to enter the information they add about volunteers and animals, and for using volunteers' details only to run their transports.
      </p>

      <H>Volunteer drivers</H>
      <UL>
        <li>You volunteer for the organization, not for us. You are not our employee, agent or contractor.</li>
        <li>
          You are responsible for holding a valid driver's license, for insurance and a roadworthy vehicle, for obeying traffic laws, and for the
          safe and humane care of animals while they are with you.
        </li>
        <li>Do not use the app while driving. Stop somewhere safe first.</li>
        <li>
          Routes, distances, times and suggested hand-off places come from public map data and are estimates. Check them yourself, and use your own
          judgment about whether a meeting place is safe.
        </li>
      </UL>

      <H>Acceptable use</H>
      <p>You agree not to:</p>
      <UL>
        <li>use other people's contact details for anything except the transports you share with them;</li>
        <li>harass anyone, or post unlawful, abusive or misleading content;</li>
        <li>try to reach another organization's information, or get around security or usage limits;</li>
        <li>use the service to sell animals or for any purpose other than animal rescue transport.</li>
      </UL>

      <H>Your content</H>
      <p>
        You keep ownership of what you enter. You give us permission to store, display and transmit it as needed to run the service for you and your
        organization. How we handle personal information is described in the{' '}
        <Link to="/privacy" className={link}>
          Privacy Policy
        </Link>
        .
      </p>

      <H>Text message terms</H>
      <UL>
        <li>
          <strong>Program:</strong> PetXport transport alerts. If you opt in, you receive texts about transports you are part of (requests for
          drivers, schedule changes and reminders) and, if you choose them, sign-in codes.
        </li>
        <li>
          <strong>Opting in is optional.</strong> It is never required to create an account or to volunteer, and it is separate from email and push
          notifications.
        </li>
        <li>
          <strong>Frequency and cost:</strong> message frequency varies with how many transports you are involved in. Message and data rates may
          apply.
        </li>
        <li>
          <strong>Stopping:</strong> reply STOP to any message to cancel, or switch text messages off on your profile. You may receive one message
          confirming that you have been unsubscribed.
        </li>
        <li>
          <strong>Help:</strong> reply HELP, or write to {mail}.
        </li>
        <li>
          <strong>Delivery:</strong> mobile carriers are not liable for delayed or undelivered messages.
        </li>
        <li>
          <strong>Privacy:</strong> your mobile information will not be sold or shared with third parties for marketing. See the{' '}
          <Link to="/privacy" className={link}>
            Privacy Policy
          </Link>
          .
        </li>
      </UL>

      <H>Availability and changes</H>
      <p>
        We work to keep the service running but do not promise that it will always be available or free of errors. Notifications can be delayed or
        fail; do not rely on the service alone for anything urgent. We may change or stop features, and will give reasonable notice of anything that
        significantly affects you.
      </p>

      <H>Suspension and closing accounts</H>
      <p>
        You can stop using the service at any time and ask for your account to be deleted. An organization can remove you from its team. We may
        suspend or close an account or an organization that breaks these terms or puts the service or other people at risk.
      </p>

      <H>Disclaimers</H>
      <p>
        The service is provided "as is" and "as available", without warranties of any kind, whether express or implied, including fitness for a
        particular purpose and accuracy of maps, routes and schedules, to the fullest extent the law allows.
      </p>

      <H>Limit of liability</H>
      <p>
        To the fullest extent the law allows, we are not liable for any indirect, incidental or consequential loss, or for injury, loss or damage to
        people, animals, vehicles or property arising from a transport, from the conduct of any organization or volunteer, or from reliance on
        information shown in the service. Nothing in these terms limits liability that cannot be limited by law.
      </p>

      <H>Governing law</H>
      <p>These terms are governed by the laws of {GOVERNING_LAW}, without regard to its conflict of law rules.</p>

      <H>Changes to these terms</H>
      <p>
        If we change these terms in a way that matters, we will post the new version here with a new date and tell account holders by email before it
        takes effect. Continuing to use the service after that means you accept the new terms.
      </p>
    </LegalShell>
  );
}

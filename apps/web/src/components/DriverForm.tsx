import { ANIMAL_SIZES, ANIMAL_SIZE_LABELS, SMS_DISCLOSURE, formatPhone, type AnimalSize, type Driver, type Place } from '@petxport/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { PlaceSearch } from './PlaceSearch';
import { Button, Checkbox, ErrorNote, Field, Input, Select, Textarea } from './ui';
import { errorMessage } from '../lib/api';

export interface DriverFormValues {
  name: string;
  email: string;
  phone: string;
  home: Place | null;
  maxMiles: string;
  availability: string;
  vehicle: string;
  crateCapacity: string;
  maxAnimalSize: AnimalSize | '';
  notes: string;
  notifyEmail: boolean;
  notifySms: boolean;
  notifyPush: boolean;
  active: boolean;
}

export const emptyDriver = (): DriverFormValues => ({
  name: '',
  email: '',
  phone: '',
  home: null,
  maxMiles: '',
  availability: '',
  vehicle: '',
  crateCapacity: '',
  maxAnimalSize: '',
  notes: '',
  notifyEmail: true,
  notifySms: false,
  notifyPush: true,
  active: true,
});

export const fromDriver = (d: Driver): DriverFormValues => ({
  name: d.name,
  email: d.email,
  phone: formatPhone(d.phone),
  home: d.homeAddress
    ? {
        name: d.homeAddress,
        lat: d.homeLat ?? 0,
        lng: d.homeLng ?? 0,
        parts: { street: d.homeStreet, city: d.homeCity, state: d.homeState, postalCode: d.homePostalCode, country: d.homeCountry },
      }
    : null,
  maxMiles: d.maxMiles?.toString() ?? '',
  availability: d.availability ?? '',
  vehicle: d.vehicle ?? '',
  crateCapacity: d.crateCapacity?.toString() ?? '',
  maxAnimalSize: d.maxAnimalSize ?? '',
  notes: d.notes ?? '',
  notifyEmail: d.notifyEmail,
  notifySms: d.notifySms,
  notifyPush: d.notifyPush,
  active: d.active,
});

/** The profile part of the API body (everything except name and email). */
export const toProfileBody = (v: DriverFormValues) => ({
  phone: v.phone,
  homeAddress: v.home?.name ?? null,
  // A saved address that was never located keeps 0,0 here; send nothing so the server looks it up.
  homeLat: v.home && (v.home.lat !== 0 || v.home.lng !== 0) ? v.home.lat : null,
  homeLng: v.home && (v.home.lat !== 0 || v.home.lng !== 0) ? v.home.lng : null,
  homeStreet: v.home?.parts?.street ?? null,
  homeCity: v.home?.parts?.city ?? null,
  homeState: v.home?.parts?.state ?? null,
  homePostalCode: v.home?.parts?.postalCode ?? null,
  homeCountry: v.home?.parts?.country ?? null,
  maxMiles: v.maxMiles ? Number(v.maxMiles) : null,
  availability: v.availability,
  vehicle: v.vehicle,
  crateCapacity: v.crateCapacity ? Number(v.crateCapacity) : null,
  maxAnimalSize: v.maxAnimalSize || null,
  notes: v.notes,
  notifyEmail: v.notifyEmail,
  notifySms: v.notifySms,
  notifyPush: v.notifyPush,
  active: v.active,
});

export function DriverForm({
  initial,
  mode,
  smsAvailable,
  showNotes = true,
  submitLabel,
  onSubmit,
  onCancel,
  extra,
}: {
  initial: DriverFormValues;
  /** new: coordinator adding someone. edit: coordinator editing. self: the driver's own profile. */
  mode: 'new' | 'edit' | 'self';
  smsAvailable: boolean;
  /** Coordinators' notes about the driver; not shown to drivers editing their own profile. */
  showNotes?: boolean;
  submitLabel: string;
  onSubmit: (values: DriverFormValues) => Promise<void>;
  onCancel?: () => void;
  extra?: ReactNode;
}) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof DriverFormValues>(key: K, value: DriverFormValues[K]) => {
    setV((old) => ({ ...old, [key]: value }));
    setSaved(false);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit(v);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const self = mode === 'self';
  return (
    <form onSubmit={submit} className="space-y-4">
      {mode === 'new' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input name="name" autoComplete="name" required value={v.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Email">
            <Input type="email" name="email" autoComplete="email" required value={v.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mobile phone" hint={self ? 'Shared with the coordinator and the drivers either side of your leg.' : undefined}>
          <Input type="tel" name="tel" autoComplete="tel" value={v.phone} onChange={(e) => set('phone', e.target.value)} onBlur={() => set('phone', formatPhone(v.phone))} placeholder="(919) 555-0123" />
        </Field>
      </div>
      <Field label="Home town or address" hint="Used only to suggest legs that start nearby. A town or zip code is enough.">
        <PlaceSearch name="address" autoComplete="street-address" value={v.home} onChange={(p) => set('home', p)} placeholder="Cary, NC" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Will travel up to" hint="Miles from home to the start of a leg.">
          <Input type="number" min={1} max={2000} value={v.maxMiles} onChange={(e) => set('maxMiles', e.target.value)} placeholder="50" />
        </Field>
        <Field label="Crates that fit">
          <Input type="number" min={0} max={50} value={v.crateCapacity} onChange={(e) => set('crateCapacity', e.target.value)} />
        </Field>
        <Field label="Largest animal">
          <Select value={v.maxAnimalSize} onChange={(e) => set('maxAnimalSize', e.target.value as AnimalSize | '')}>
            <option value="">Any size</option>
            {ANIMAL_SIZES.map((s) => (
              <option key={s} value={s}>
                {ANIMAL_SIZE_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vehicle">
          <Input name="vehicle" value={v.vehicle} onChange={(e) => set('vehicle', e.target.value)} placeholder="Blue Subaru Outback" />
        </Field>
        <Field label="Usual availability">
          <Input name="availability" value={v.availability} onChange={(e) => set('availability', e.target.value)} placeholder="Weekends, some Friday afternoons" />
        </Field>
      </div>
      {showNotes && (
        <Field label="Notes">
          <Textarea value={v.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Experience, preferences, anything worth remembering. Visible to coordinators only." />
        </Field>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-slate-700">{self ? 'Tell me about transports by' : 'Notify by'}</legend>
        <Checkbox label="Email" checked={v.notifyEmail} onChange={(on) => set('notifyEmail', on)} />
        <Checkbox label="Push notification on phones and browsers where it has been turned on" checked={v.notifyPush} onChange={(on) => set('notifyPush', on)} />
        {smsAvailable && self && (
          <>
            <Checkbox label="Text message to the phone number above. Optional." checked={v.notifySms} onChange={(on) => set('notifySms', on)} />
            <p className="pl-6 text-xs text-slate-500">{SMS_DISCLOSURE}</p>
          </>
        )}
        {smsAvailable && !self && <p className="text-xs text-slate-500">Text messages can only be switched on by the driver, on their own profile.</p>}
      </fieldset>
      <Checkbox
        label={self ? 'I am available to drive. Untick to pause requests without leaving the team.' : 'Active: include in suggestions and requests'}
        checked={v.active}
        onChange={(on) => set('active', on)}
      />
      {extra}
      <ErrorNote error={error} />
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {saved && <span className="text-sm text-emerald-700">Saved</span>}
      </div>
    </form>
  );
}

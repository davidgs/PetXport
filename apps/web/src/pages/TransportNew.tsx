import { ANIMAL_SIZES, ANIMAL_SIZE_LABELS, type AnimalSize, type Place } from '@petxport/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { PlaceSearch } from '../components/PlaceSearch';
import { Button, Card, ErrorNote, Field, Input, PageTitle, Select, Textarea } from '../components/ui';
import { api, errorMessage, useOrg, useOrgPath } from '../lib/api';
import { toLocalInput } from '../lib/format';

interface AnimalDraft {
  name: string;
  breed: string;
  size: AnimalSize;
  notes: string;
}
const blankAnimal = (): AnimalDraft => ({ name: '', breed: '', size: 'medium', notes: '' });

export function TransportNew() {
  const { apiBase, base } = useOrgPath();
  const org = useOrg();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [origin, setOrigin] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [departAt, setDepartAt] = useState(() => {
    const d = new Date(Date.now() + 7 * 86400_000);
    d.setHours(8, 0, 0, 0);
    return toLocalInput(d.toISOString());
  });
  const [notes, setNotes] = useState('');
  const [animals, setAnimals] = useState<AnimalDraft[]>([blankAnimal()]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const setAnimal = (i: number, patch: Partial<AnimalDraft>) => setAnimals((list) => list.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!origin || !destination) {
      setError('Pick the pickup place and the destination from the search results.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { id } = await api<{ id: string }>(`${apiBase}/transports`, {
        body: {
          title,
          origin,
          destination,
          departAt: new Date(departAt).toISOString(),
          notes,
          animals: animals.filter((a) => a.name.trim()),
        },
      });
      await qc.invalidateQueries({ queryKey: ['transports'] });
      navigate(`${base}/transports/${id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4">
      <PageTitle title="New transport" />
      <Card className="space-y-4">
        <Field label="Name for this transport">
          <Input name="title" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Biscuit to his foster in Brooklyn" maxLength={200} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Pickup place">
            <PlaceSearch name="origin" value={origin} onChange={setOrigin} />
          </Field>
          <Field label="Destination">
            <PlaceSearch name="destination" value={destination} onChange={setDestination} />
          </Field>
        </div>
        <Field label="Leaves the pickup place at" hint="In your own time zone. Each leg's times are worked out from this.">
          <Input type="datetime-local" required value={departAt} onChange={(e) => setDepartAt(e.target.value)} />
        </Field>
        <Field label="Notes for drivers (optional)">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Paperwork travels in the blue folder. Please send a photo at each handoff." />
        </Field>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-semibold">Who is travelling</h2>
        {animals.map((a, i) => (
          <div key={i} className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <Input aria-label="Name" placeholder="Name" value={a.name} onChange={(e) => setAnimal(i, { name: e.target.value })} />
            <Input aria-label="Breed" placeholder="Breed (optional)" value={a.breed} onChange={(e) => setAnimal(i, { breed: e.target.value })} />
            <Select aria-label="Size" value={a.size} onChange={(e) => setAnimal(i, { size: e.target.value as AnimalSize })}>
              {ANIMAL_SIZES.map((s) => (
                <option key={s} value={s}>
                  {ANIMAL_SIZE_LABELS[s]}
                </option>
              ))}
            </Select>
            <Button variant="ghost" small onClick={() => setAnimals((list) => list.filter((_, j) => j !== i))} aria-label="Remove">
              Remove
            </Button>
            <Input className="sm:col-span-4" aria-label="Notes" placeholder="Medical or behaviour notes (optional)" value={a.notes} onChange={(e) => setAnimal(i, { notes: e.target.value })} />
          </div>
        ))}
        <Button variant="secondary" small onClick={() => setAnimals((list) => [...list, blankAnimal()])}>
          Add another animal
        </Button>
      </Card>

      <ErrorNote error={error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Planning the route…' : 'Plan the route'}
        </Button>
        <p className="text-sm text-slate-500">
          {busy
            ? 'Long routes can take up to a minute.'
            : `The route is split into legs of about ${org.data?.legTargetMiles ?? 100} miles or ${Math.round(((org.data?.legTargetMinutes ?? 120) / 60) * 10) / 10} hours. You can adjust the handoff points afterwards.`}
        </p>
      </div>
    </form>
  );
}

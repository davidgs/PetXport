import { MAX_PHOTO_BYTES } from '@petxport/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage, useMe } from '../lib/api';
import { Button, Card, ErrorNote } from './ui';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

const SIZES = { sm: 'h-7 w-7 text-[11px]', md: 'h-10 w-10 text-sm', lg: 'h-20 w-20 text-2xl' } as const;

/** A person's picture, or their initials when they have not added one. */
export function Avatar({ name, photo, size = 'md', className = '' }: { name: string; photo: string | null | undefined; size?: keyof typeof SIZES; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const box = `${SIZES[size]} shrink-0 rounded-full ring-1 ring-slate-200 ${className}`;
  if (photo && broken !== photo) {
    return <img src={photo} alt={`Picture of ${name}`} loading="lazy" onError={() => setBroken(photo)} className={`${box} bg-slate-100 object-cover`} />;
  }
  return (
    <span aria-hidden className={`${box} inline-flex items-center justify-center bg-brand-100 font-semibold text-brand-800`}>
      {initials(name) || '?'}
    </span>
  );
}

/**
 * Crops the middle square out of a picture, scales it down and re-encodes it as JPEG in the
 * browser. Re-encoding also drops hidden details a phone adds to photos, such as where it was taken.
 */
async function preparePhoto(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a picture file.');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error('That file could not be read as a picture. Try a JPEG or PNG.');
  });
  const side = Math.min(bitmap.width, bitmap.height);
  for (const [px, quality] of [
    [400, 0.85],
    [320, 0.8],
    [240, 0.75],
  ] as const) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(px, side);
    canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', quality).split(',')[1]!;
    if ((data.length * 3) / 4 <= MAX_PHOTO_BYTES) return data;
  }
  throw new Error('That picture could not be made small enough. Try a different one.');
}

/** Lets someone add, replace or remove the picture of themselves that their teams see. */
export function PhotoCard() {
  const me = useMe();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const user = me.data?.user;
  if (!user) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      // The picture appears next to the person's name all over the app.
      await qc.invalidateQueries();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Your picture</h2>
      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={user.name} photo={user.photo} size="lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-slate-600">
            A clear picture of your face helps the driver you are meeting spot you at a handoff. It is shown to the coordinators and drivers of the rescues you belong to.
          </p>
          <div className="flex flex-wrap gap-2">
            <label className={`inline-flex cursor-pointer items-center rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-800 ${busy ? 'pointer-events-none opacity-50' : ''}`}>
              {busy ? 'Working…' : user.photo ? 'Change picture' : 'Add a picture'}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void run(async () => api('/me/photo', { method: 'PUT', body: { data: await preparePhoto(file) } }));
                }}
              />
            </label>
            {user.photo && (
              <Button variant="secondary" disabled={busy} onClick={() => run(() => api('/me/photo', { method: 'DELETE' }))}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>
      <ErrorNote error={error} />
    </Card>
  );
}

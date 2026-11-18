import { Avatar } from './Avatar';
import type { ChatMessage } from '@petxport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, useOrgPath } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Button, ErrorNote, Spinner } from './ui';

/** Live conversation for one transport's coordinators and confirmed drivers. */
export function Chat({ transportId, myUserId }: { transportId: string; myUserId: string }) {
  const { slug, apiBase } = useOrgPath();
  const qc = useQueryClient();
  const key = ['messages', slug, transportId];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api<ChatMessage[]>(`${apiBase}/transports/${transportId}/messages`),
    // The socket delivers new messages; this is a safety net if it drops.
    refetchInterval: 30_000,
  });
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState('');
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const add = (m: ChatMessage) =>
    qc.setQueryData<ChatMessage[]>(key, (old = []) => (old.some((o) => o.id === m.id) ? old : [...old, m]));

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/api/ws`);
      socket.onopen = () => socket?.send(JSON.stringify({ type: 'subscribe', slug, transportId }));
      socket.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as { type: string; message?: ChatMessage };
        if (msg.type === 'subscribed') setLive(true);
        // Taken off the transport or removed from the organization while the chat was open.
        if (msg.type === 'unsubscribed') {
          setLive(false);
          void qc.invalidateQueries({ queryKey: ['transport', slug, transportId] });
        }
        if (msg.type === 'message' && msg.message) {
          add(msg.message);
          void api(`${apiBase}/transports/${transportId}/messages/read`, { method: 'POST', body: {} }).catch(() => undefined);
        }
      };
      socket.onclose = () => {
        setLive(false);
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, transportId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [data?.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError('');
    try {
      add(await api<ChatMessage>(`${apiBase}/transports/${transportId}/messages`, { body: { body } }));
      setText('');
    } catch (err) {
      setSendError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  if (isLoading) return <Spinner />;
  if (error) return <ErrorNote error={error} />;

  return (
    <div className="flex h-[60vh] min-h-80 flex-col rounded-xl bg-white ring-1 ring-slate-200">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-xs text-slate-500">
        <span>Coordinators and confirmed drivers on this transport</span>
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-slate-300'}`} />
          {live ? 'Live' : 'Reconnecting…'}
        </span>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {data?.length === 0 && <p className="py-8 text-center text-sm text-slate-500">No messages yet. Say hello to the team.</p>}
        {data?.map((m) => {
          const mine = m.userId === myUserId;
          return (
            <div key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
              <span className="mb-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                {!mine && <Avatar name={m.userName} photo={m.userPhoto} size="sm" />}
                {mine ? 'You' : m.userName} · {fmtDateTime(m.createdAt)}
              </span>
              <p className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-900'}`}>
                {m.body}
              </p>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      {sendError && <div className="px-3 pb-2"><ErrorNote error={sendError} /></div>}
      <form
        className="flex gap-2 border-t border-slate-200 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          placeholder="Message the team"
          aria-label="Message"
          className="min-w-0 flex-1 rounded-lg border-0 px-3 py-2 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600"
        />
        <Button type="submit" disabled={!text.trim() || sending}>
          Send
        </Button>
      </form>
    </div>
  );
}

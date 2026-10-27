import type { OpId } from '../src/crdt/index.js';
import type { PresenceState } from '../src/domain/messages.js';
import { CollabClient } from './collabClient.js';

const COLORS = ['#e4572e', '#29335c', '#f3a712', '#669bbc', '#a8c686', '#7b2cbf', '#2a9d8f'];

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** One replica per tab: sessionStorage survives reloads of the tab but is not shared between tabs. */
function tabReplicaId(): string {
  try {
    const existing = sessionStorage.getItem('cosync.replica');
    if (existing) return existing;
    const fresh = `tab-${randomToken()}`;
    sessionStorage.setItem('cosync.replica', fresh);
    return fresh;
  } catch {
    return `tab-${randomToken()}`;
  }
}

// The textarea speaks UTF-16 offsets, the CRDT speaks code points.
const toCodePoints = (text: string, utf16: number): number => [...text.slice(0, utf16)].length;
const toUtf16 = (text: string, codePoints: number): number => [...text].slice(0, codePoints).join('').length;

async function resolveDocId(): Promise<string> {
  const params = new URLSearchParams(location.search);
  const existing = params.get('doc');
  if (existing) return existing;
  const res = await fetch('/api/docs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Open this page in a second tab and type in both.\n' }),
  });
  const { docId } = (await res.json()) as { docId: string };
  params.set('doc', docId);
  history.replaceState(null, '', `?${params.toString()}`);
  return docId;
}

async function start(): Promise<void> {
  const editor = byId('editor') as HTMLTextAreaElement;
  const status = byId('status');
  const peersList = byId('peers');
  const shareLink = byId('share') as HTMLAnchorElement;

  const docId = await resolveDocId();
  shareLink.href = location.href;
  shareLink.textContent = docId;
  const replicaId = tabReplicaId();
  const name = `Guest ${replicaId.slice(-3)}`;
  const color = COLORS[replicaId.charCodeAt(replicaId.length - 1) % COLORS.length] ?? '#333333';

  let selection: { anchor: OpId | null; head: OpId | null } = { anchor: null, head: null };
  let shown = '';

  const client = new CollabClient(
    docId,
    replicaId,
    { name, color },
    {
      onText: (text, remote) => {
        if (!remote) {
          shown = text;
          return;
        }
        const start = client.doc.resolveAnchor(selection.anchor);
        const end = client.doc.resolveAnchor(selection.head);
        editor.value = text;
        shown = text;
        editor.setSelectionRange(toUtf16(text, start), toUtf16(text, end));
        renderPeers(client.peers);
      },
      onPresence: (peers) => {
        renderPeers(peers);
      },
      onJoined: ({ mode, received }) => {
        status.textContent = `online (${mode}, ${received} received)`;
        status.dataset.state = 'online';
      },
      onError: (code, message) => {
        status.textContent = `error: ${code} ${message}`;
      },
    },
  );

  function rememberSelection(): void {
    const text = editor.value;
    const anchor = toCodePoints(text, editor.selectionStart);
    const head = toCodePoints(text, editor.selectionEnd);
    selection = { anchor: client.doc.anchorAt(anchor), head: client.doc.anchorAt(head) };
    client.setCursor(anchor, head);
  }

  function renderPeers(peers: ReadonlyMap<string, PresenceState>): void {
    peersList.replaceChildren(
      ...[...peers.values()].map((peer) => {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = peer.user.color;
        const label = document.createElement('span');
        let where = '';
        if (peer.cursor) {
          const at = client.doc.resolveAnchor(peer.cursor.head);
          const before = [...client.text].slice(0, at).join('');
          const lines = before.split('\n');
          where = ` - line ${lines.length}, col ${(lines.at(-1)?.length ?? 0) + 1}`;
        }
        label.textContent = `${peer.user.name}${where}`;
        li.append(dot, label);
        return li;
      }),
    );
  }

  editor.addEventListener('input', () => {
    const next = editor.value;
    const before = [...shown];
    const after = [...next];
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
      suffix++;
    }
    client.delete(prefix, before.length - prefix - suffix);
    client.insert(prefix, after.slice(prefix, after.length - suffix).join(''));
    shown = next;
    rememberSelection();
  });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === editor) rememberSelection();
  });

  let retry = 0;
  let heartbeat: number | undefined;
  const connect = () => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    status.textContent = 'connecting';
    status.dataset.state = 'connecting';
    socket.addEventListener('open', () => {
      retry = 0;
      client.attach({
        send: (data) => {
          socket.send(data);
        },
      });
      heartbeat = window.setInterval(() => {
        client.heartbeat();
      }, client.heartbeatMs);
    });
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      client.receive(event.data);
    });
    socket.addEventListener('close', () => {
      window.clearInterval(heartbeat);
      client.detach();
      status.textContent = `offline, ${client.unacknowledged} edits queued`;
      status.dataset.state = 'offline';
      // Edits keep working offline; they are resent after the next welcome.
      const delay = Math.min(10_000, 250 * 2 ** retry++);
      window.setTimeout(connect, delay);
    });
  };
  connect();
}

start().catch((err: unknown) => {
  document.body.textContent = `failed to start: ${String(err)}`;
});

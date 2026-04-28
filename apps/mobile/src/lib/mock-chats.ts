export type ConversationKind = 'private' | 'group';

export type Conversation = {
  id: string;
  kind: ConversationKind;
  name: string;
  message: string;
  time: string;
  unread: number;
  accent: string;
  subtitle: string;
  members?: string[];
};

export type ChatMessage = {
  id: string;
  author: 'me' | 'them';
  sender?: string;
  text: string;
  time: string;
};

export const conversations: Conversation[] = [
  {
    id: '1',
    kind: 'private',
    name: 'Mira Chen',
    message: 'Voice note sounds good. Send it over.',
    time: '9:42',
    unread: 2,
    accent: '#60a5fa',
    subtitle: 'online',
  },
  {
    id: '2',
    kind: 'private',
    name: 'Noah',
    message: 'I pushed the new mockups.',
    time: '9:18',
    unread: 0,
    accent: '#a78bfa',
    subtitle: 'last seen 9:20',
  },
  {
    id: '3',
    kind: 'group',
    name: 'Design Crit',
    message: 'Ari: the dark version is cleaner.',
    time: 'Yesterday',
    unread: 5,
    accent: '#f472b6',
    subtitle: 'Ari, Mira, Noah, you',
    members: ['Ari', 'Mira', 'Noah'],
  },
  {
    id: '4',
    kind: 'private',
    name: 'Brian',
    message: 'Let’s keep this native, not webby.',
    time: 'Yesterday',
    unread: 0,
    accent: '#34d399',
    subtitle: 'last seen yesterday',
  },
  {
    id: '5',
    kind: 'group',
    name: 'Weekend',
    message: 'Dinner at 7?',
    time: 'Mon',
    unread: 0,
    accent: '#f59e0b',
    subtitle: '5 members',
    members: ['Kai', 'Mira', 'Noah'],
  },
  {
    id: '6',
    kind: 'group',
    name: 'Product',
    message: 'Native tabs landed.',
    time: 'Sun',
    unread: 1,
    accent: '#22d3ee',
    subtitle: '8 members',
    members: ['Mira', 'Noah', 'Ari'],
  },
  {
    id: '7',
    kind: 'private',
    name: 'Kai',
    message: 'Ship the skeleton first.',
    time: 'Sat',
    unread: 0,
    accent: '#fb7185',
    subtitle: 'last seen Sat',
  },
];

export const privateMessages: ChatMessage[] = [
  {
    id: 'p01',
    author: 'them',
    text: 'I tried the build on the train this morning.',
    time: '8:07',
  },
  {
    id: 'p02',
    author: 'me',
    text: 'Any obvious layout breakage?',
    time: '8:09',
  },
  {
    id: 'p03',
    author: 'them',
    text: 'Mostly good. The list header feels much calmer now.',
    time: '8:10',
  },
  {
    id: 'p04',
    author: 'them',
    text: 'The search collapse is still a little sharp when I fling hard.',
    time: '8:11',
  },
  {
    id: 'p05',
    author: 'me',
    text: 'I can tune that after the detail view stops moving around.',
    time: '8:14',
  },
  {
    id: 'p06',
    author: 'them',
    text: 'Makes sense.',
    time: '8:14',
  },
  {
    id: 'p07',
    author: 'me',
    text: 'How does the composer feel when the keyboard opens?',
    time: '8:18',
  },
  {
    id: 'p08',
    author: 'them',
    text: 'Much better than before. It follows the keyboard now.',
    time: '8:19',
  },
  {
    id: 'p09',
    author: 'them',
    text: 'The message list should move with it too though.',
    time: '8:19',
  },
  {
    id: 'p10',
    author: 'me',
    text: 'Agreed. The relative position should stay locked.',
    time: '8:20',
  },
  {
    id: 'p11',
    author: 'them',
    text: 'Also try a very long message so the timestamp has to wrap naturally into the bottom corner without looking like its own content row.',
    time: '8:22',
  },
  {
    id: 'p12',
    author: 'me',
    text: 'That edge case is useful. I want it to reserve space but still feel compact.',
    time: '8:24',
  },
  {
    id: 'p13',
    author: 'them',
    text: 'Exactly.',
    time: '8:25',
  },
  {
    id: 'p14',
    author: 'me',
    text: 'I moved the profile actions out of the message stream.',
    time: '8:31',
  },
  {
    id: 'p15',
    author: 'them',
    text: 'That was the right call. It felt like a contact page sitting inside every thread.',
    time: '8:33',
  },
  {
    id: 'p16',
    author: 'me',
    text: 'The profile page can reuse the hero layout later.',
    time: '8:34',
  },
  {
    id: 'p17',
    author: 'them',
    text: 'Yeah, keep it there.',
    time: '8:35',
  },
  {
    id: 'p18',
    author: 'me',
    text: 'I am adding enough mock messages to test real scrolling now.',
    time: '8:41',
  },
  {
    id: 'p19',
    author: 'them',
    text: 'Good. Five messages hides too many problems.',
    time: '8:42',
  },
  {
    id: 'p20',
    author: 'me',
    text: 'Especially the jump-to-latest behavior.',
    time: '8:43',
  },
  {
    id: 'p21',
    author: 'them',
    text: 'That button should not be visible all the time.',
    time: '8:44',
  },
  {
    id: 'p22',
    author: 'me',
    text: 'Only when you are far away and start heading back down.',
    time: '8:45',
  },
  {
    id: 'p23',
    author: 'them',
    text: 'Right. If I keep reading older messages, it should stay hidden.',
    time: '8:46',
  },
  {
    id: 'p24',
    author: 'me',
    text: 'I will tie it to scroll direction and distance from the bottom.',
    time: '8:48',
  },
  {
    id: 'p25',
    author: 'them',
    text: 'Nice.',
    time: '8:49',
  },
  {
    id: 'p26',
    author: 'me',
    text: 'The button should sit above the composer, not in the nav bar.',
    time: '8:51',
  },
  {
    id: 'p27',
    author: 'them',
    text: 'Agree. Bottom right feels reachable and familiar.',
    time: '8:52',
  },
  {
    id: 'p28',
    author: 'me',
    text: 'I will animate it in with opacity, translate, and scale.',
    time: '8:53',
  },
  {
    id: 'p29',
    author: 'them',
    text: 'No giant pill. Just a small affordance.',
    time: '8:55',
  },
  {
    id: 'p30',
    author: 'me',
    text: 'A circular down-arrow button should be enough.',
    time: '8:56',
  },
  {
    id: 'p31',
    author: 'them',
    text: 'Test it with a long scroll from the top.',
    time: '9:03',
  },
  {
    id: 'p32',
    author: 'me',
    text: 'Will do.',
    time: '9:04',
  },
  {
    id: 'p33',
    author: 'them',
    text: 'Can you send the latest version?',
    time: '9:28',
  },
  {
    id: 'p34',
    author: 'me',
    text: 'Yes. I cleaned up the motion and the spacing.',
    time: '9:31',
  },
  {
    id: 'p35',
    author: 'them',
    text: 'Nice. The header feels much more native now.',
    time: '9:36',
  },
  {
    id: 'p36',
    author: 'me',
    text: 'I’ll wire the detail screen after this.',
    time: '9:40',
  },
  {
    id: 'p37',
    author: 'them',
    text: 'Voice note sounds good. Send it over.',
    time: '9:42',
  },
];

export const groupMessages: ChatMessage[] = [
  {
    id: 'g1',
    author: 'them',
    sender: 'Ari',
    text: 'The dark version is cleaner.',
    time: '8:54',
  },
  {
    id: 'g2',
    author: 'them',
    sender: 'Mira',
    text: 'Agree. Keep the top chrome quiet.',
    time: '8:56',
  },
  {
    id: 'g3',
    author: 'me',
    text: 'I’ll make the list and detail share the same rhythm.',
    time: '9:02',
  },
  {
    id: 'g4',
    author: 'them',
    sender: 'Noah',
    text: 'Group chats need sender names visible.',
    time: '9:05',
  },
  {
    id: 'g5',
    author: 'me',
    text: 'Done. Private stays simpler.',
    time: '9:09',
  },
];

export function findConversation(id: string | string[] | undefined) {
  return (
    conversations.find((conversation) => conversation.id === String(id ?? '')) ?? conversations[0]
  );
}

export function getConversationMessages(conversation: Conversation) {
  if (conversation.id === '1') {
    return privateMessages;
  }

  return conversation.kind === 'group' ? groupMessages : privateMessages.slice(-5);
}

# InfChat Privacy Policy

Effective date: 2026-04-28

InfChat is an open-source chat application. The source code may be inspected, modified, and self-hosted by other people. This Privacy Policy applies only to the InfChat mobile app version distributed by Bojin Li through Apple App Store Connect and TestFlight, and to the backend service operated for that distributed app.

This document describes what data that distributed app stores, what data it does not store, and how that data is used.

## 1. Data Controller and Contact

The App Store and TestFlight version of InfChat is operated by Bojin Li.

For privacy questions, account deletion requests, or data access requests, contact:

- Email: infchat@bojin.li

## 2. Summary

InfChat stores the minimum data needed to provide username-based account access, user profiles, friend relationships, conversations, and messages.

InfChat does not sell personal data, does not use third-party advertising SDKs, does not track users across apps or websites, and does not request access to device contacts, precise location, camera, microphone, photo library, health data, payment data, or advertising identifiers in the current app implementation.

## 3. Data Stored on the InfChat Backend

The distributed InfChat app uses a PocketBase backend. Based on the current backend schema, the backend stores the following categories of data.

### 3.1 Account Data

When a user creates an account or signs in, the backend stores account records required for authentication, including:

- user ID;
- username;
- password authentication data maintained by PocketBase;
- account creation and update metadata maintained by PocketBase.

The current app uses username and password authentication. It does not require an email address, phone number, real name, OAuth account, one-time password, or multi-factor authentication factor.

The app sends the password to the backend only for account creation and sign-in. The app does not intentionally store the raw password after authentication.

### 3.2 Profile Data

The backend stores profile records used for friend discovery and user display, including:

- linked user ID;
- username;
- display name;
- optional avatar file if a profile avatar is uploaded;
- profile creation and update timestamps.

Profiles can be visible to signed-in users so that users can search for and identify other InfChat users.

### 3.3 Friendship Data

The backend stores friendship records used to send, accept, decline, and cancel friend requests, including:

- requester user ID;
- recipient user ID;
- pair key used to identify a friendship pair;
- friendship status, such as pending, accepted, declined, or canceled;
- acceptance timestamp when applicable;
- creation and update timestamps.

Friendship records are visible only to users who are participants in the relevant friendship record.

### 3.4 Conversation Data

The backend stores conversation records used to show chat lists and conversation membership, including:

- conversation ID;
- conversation kind, such as private or group;
- private conversation pair key when applicable;
- creator user ID when available;
- member user IDs;
- optional conversation title;
- last message preview text;
- last message timestamp;
- creation and update timestamps.

Conversation records are visible only to authenticated users who are members of the conversation.

### 3.5 Message Data

The backend stores message records used to deliver and display chat messages, including:

- message ID;
- conversation ID;
- sender user ID;
- message kind, such as text, image, or voice;
- message body;
- creation and update timestamps.

The current app sends text messages. The backend schema allows message kinds for image and voice messages, but the current app implementation does not request camera, microphone, or photo library access.

Message records are visible only to authenticated users who are members of the related conversation.

## 4. Data Stored Locally on the Device

The app stores some data locally on the user's device to keep the app signed in and improve offline or unreliable-network behavior.

### 4.1 Authentication Session

The app stores PocketBase authentication session data in the device secure storage using Expo SecureStore. This may include the authentication token and serialized PocketBase auth record needed to keep the user signed in.

### 4.2 Local Cache

The app uses a local SQLite database named `infchat-cache.db` to cache API responses. The cache may include:

- friendship records;
- profile records;
- profile search results;
- conversation records;
- message records.

This cache is stored on the user's device and is used to show previously loaded data when network requests fail or while data is being refreshed.

## 5. Data InfChat Does Not Collect in the Current App

The current App Store/TestFlight app implementation does not intentionally collect or store:

- legal name;
- email address;
- phone number;
- postal address;
- device contact list or address book;
- precise or approximate location;
- camera captures;
- microphone recordings;
- photo library contents;
- payment card or purchase information;
- health or fitness data;
- advertising identifier;
- cross-app tracking data;
- third-party advertising or analytics identifiers.

The app also does not include third-party advertising and does not sell user data.

## 6. How Data Is Used

InfChat uses stored data only to operate the app and backend service, including to:

- create and authenticate user accounts;
- display user profiles;
- allow users to search for other users by username;
- create, accept, decline, and cancel friend requests;
- create and display conversations;
- send, store, and display messages;
- show recent conversation state and last-message previews;
- maintain local app cache and signed-in state;
- diagnose operational, abuse, security, or reliability issues.

## 7. Data Sharing and Disclosure

InfChat does not sell personal data.

Data may be processed by infrastructure providers used to host, operate, secure, back up, or maintain the InfChat backend and related services. Data may also be disclosed if required by law, legal process, or necessary to protect the rights, safety, security, or integrity of InfChat, its users, or its infrastructure.

Messages and profile information are shared with other InfChat users only as required by the app's functionality. For example, messages are available to members of the relevant conversation, and profile information is available to signed-in users for discovery and display.

## 8. Retention and Deletion

Account, profile, friendship, conversation, and message data is retained for as long as needed to provide InfChat, maintain account history, support conversations, resolve disputes, enforce rules, comply with legal obligations, or maintain service integrity.

The current app may not provide an in-app account deletion flow. Users may request account deletion or data deletion by emailing infchat@bojin.li. Deletion may be limited where retention is required for legal, security, abuse-prevention, backup, or operational reasons.

Local device data can also be removed by signing out where applicable, clearing app data, or deleting the app from the device.

## 9. Security

InfChat uses reasonable technical and organizational measures to protect stored data, including device secure storage for authentication session data and backend access rules that restrict friendship, conversation, and message records to the relevant authenticated users.

No internet or mobile service can guarantee absolute security. Users should not send highly sensitive information through InfChat.

## 10. Children's Privacy

InfChat is not intended for children under 13 years old. If the operator learns that personal data from a child under 13 has been collected, reasonable steps will be taken to delete that data.

## 11. Open-Source Deployments

Because InfChat is open source, other people may run modified or self-hosted versions of the app or backend. This Privacy Policy does not apply to third-party forks, modified builds, self-hosted deployments, or unofficial distributions. Operators of those versions are responsible for their own privacy practices.

## 12. Changes to This Policy

This policy may be updated as InfChat changes. The effective date at the top of this document indicates the latest version.

# Set up Firebase cloud sync

1. Open https://console.firebase.google.com and create a project on the free Spark plan.
   Google Analytics is optional. Do not enable billing for this app's auth/database needs.
2. Register a Web app (`</>`). Copy its apiKey, authDomain, projectId and appId into
   the matching VITE_FIREBASE_* variables in `.env.local` (see `.env.example`).
3. Authentication > Get started > Sign-in method: enable Email/Password.
   Google is supported in the code but is not currently shown in the login dialog.
4. Authentication > Settings > Authorized domains: add your deployed app's hostname
   and localhost for local development.
5. Firestore Database > Create database: use Standard edition, a European region,
   and production mode.
6. In Firestore > Rules, replace the rules with the contents of `firestore.rules`
   and Publish. They restrict every document to its signed-in owner.
7. Disable single-field indexing for the `payload` field in the `chunks` collection
   group (ascending, descending, and array). Alternatively deploy both rules and
   indexes from this directory using Firebase CLI:
   `firebase deploy --only firestore --project YOUR_PROJECT_ID`.
8. Add the same four environment variables to Vercel's project settings for each
   deployment environment you use, then redeploy. Vite embeds them at build time.
9. Create an account through the app, then check your repertoires on another browser.

## Existing data

Firebase accounts are separate from Supabase accounts. Use Sign Up to create the
Firebase account; the old Supabase password is not migrated automatically.
Repertoires saved in this browser stay available and upload on the first Firebase
sign-in. Keep an exported backup before migration. Do not clear browser storage.

Data that exists only in Supabase has NOT been migrated by this code change.
Resume the old project and recover/export those repertoires before retiring it.
`supabase-schema.sql` remains as a reference for recovering the old database.
No old project data or environment files are deleted by this switch.

## Storage behavior and validation

Each repertoire is serialized and split into binary documents of at most 400 KB,
so nested trees do not hit Firestore's map nesting or 1 MiB document limits.
The current atomic save supports 8 MB of JSON per repertoire. Bigger saves report
an error and keep the local file. The Spark storage and daily operation quotas
still apply, and each chunk counts as a database read/write.

Existing generated comments in saved trees are preserved because they cannot be
reliably distinguished from edited personal notes. New generated moves and PGN
exports contain no automatically added comments.

Before production use, verify email signup/signin/signout, reload session recovery,
first sign-in upload, cross-browser fetch/edit/delete, and denied access from a
second account. Live verification requires a configured project and published rules.

## Configured project (19 October 2026)

- Firebase project: `mainline-18076`, Spark plan.
- Web app: `Main Line`.
- Email/password sign-in enabled.
- Default Firestore Standard database created in `eur3` (Europe).
- Owner-only rules published and payload indexing exemption saved.
- Public Firebase configuration added to `.env.local`.
- Matching four variables saved to Vercel project `main-line-x115` for Production.
- Production still needs the updated source deployed; redeploying the old commit alone
  will not switch it to Firebase. Live account creation and cross-device sync remain
  unverified. Existing Supabase-only data has not been migrated.

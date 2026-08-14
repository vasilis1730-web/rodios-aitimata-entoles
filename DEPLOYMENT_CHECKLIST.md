# ΡΟΔΙΟΣ — Checklist εγκατάστασης

Αυτό το checklist αφορά αποκλειστικά το νέο έργο `rodios-aitimata-entoles`.

## 0. Κανόνας ασφαλείας

- Δεν αλλάζουμε αρχεία, ρυθμίσεις, Pages ή δεδομένα του `dimotiki-enotita-rhodes`.
- Στο παλιό Supabase εκτελούνται μόνο τα τρία SQL του `supabase/export-readonly/`.
- Όλα τα migrations, οι χρήστες, τα Storage buckets και οι Edge Functions δημιουργούνται μόνο σε νέο Supabase project.
- Πριν από κάθε εκτέλεση ελέγξτε οπτικά το Project Ref που εμφανίζεται στο Supabase Dashboard.

## 1. Εξαγωγή μόνο ανάγνωσης από το παλιό Supabase

Στο SQL Editor του παλιού project:

1. Εκτελέστε `supabase/export-readonly/01_reference_data_export.sql`.
2. Αντιγράψτε ολόκληρη την τιμή `rodios_reference_export` σε ιδιωτικό τοπικό αρχείο. Μην τη βάλετε στο GitHub.
3. Εκτελέστε `supabase/export-readonly/02_reference_data_check.sql` και κρατήστε το αποτέλεσμα.
4. Εκτελέστε `supabase/export-readonly/03_auth_accounts_export.sql` και κρατήστε τη λίστα email/ρόλων.

Τα τρία αρχεία περιέχουν μόνο `SELECT`/CTE. Δεν μεταβάλλουν την παλιά βάση.

## 2. Δημιουργία νέου Supabase

1. Δημιουργήστε νέο Supabase project και σημειώστε:
   - `NEW_PROJECT_REF`
   - Project URL
   - publishable key (`sb_publishable_...`) ή legacy anon/public key
2. Στο SQL Editor του νέου project εκτελέστε με αυτή ακριβώς τη σειρά:
   - `supabase/migrations/202608120001_core.sql`
   - `supabase/migrations/202608120002_workflows.sql`
   - `supabase/migrations/202608120003_storage.sql`
3. Μην εκτελέσετε κανένα από αυτά στο παλιό project.

## 3. Νέοι λογαριασμοί χρηστών

1. Στο νέο Supabase ανοίξτε Authentication → Users.
2. Δημιουργήστε έναν νέο λογαριασμό για κάθε email του `03_auth_accounts_export.sql`.
3. Χρησιμοποιήστε νέα προσωρινά passwords τουλάχιστον 6 χαρακτήρων.
4. Δηλώστε τα email ως confirmed.
5. Δεν αντιγράφουμε παλιούς κωδικούς ή password hashes.

## 4. Εισαγωγή μόνο των δεδομένων αναφοράς

1. Ανοίξτε `supabase/bootstrap/01_import_reference_data.sql`.
2. Αντικαταστήστε μόνο το `PASTE_THE_EXPORTED_JSON_HERE` με το JSON του βήματος 1.
3. Εκτελέστε το τροποποιημένο SQL μόνο στο νέο Supabase.
4. Εκτελέστε `supabase/bootstrap/02_verify_clean_start.sql`.
5. Οι μετρήσεις `issues`, `work_orders`, `payments`, `protocols` και `acknowledgments` πρέπει όλες να είναι `0`.
6. Επιβεβαιώστε ότι εμφανίζονται ακριβώς τα τρία σωστά ονόματα της Επιτροπής.

## 5. Edge Functions

Από τον ριζικό φάκελο του νέου repository:

```bash
npx supabase@latest login
npx supabase@latest link --project-ref NEW_PROJECT_REF
npx supabase@latest functions deploy citizen-bridge
npx supabase@latest functions deploy verify-pdf-signatures
npx supabase@latest functions deploy admin-delete
npx supabase@latest functions deploy send-order-email
npx supabase@latest functions deploy manage-app-user
npx supabase@latest functions deploy resolve-maps-link
```

Το `supabase/config.toml` εφαρμόζει τον σωστό έλεγχο JWT ανά Function. Μη χρησιμοποιήσετε γενικό `--no-verify-jwt` στις παραπάνω εντολές.

Ορίστε τα secrets αποστολής email:

```bash
npx supabase@latest secrets set --project-ref NEW_PROJECT_REF RESEND_API_KEY=YOUR_RESEND_KEY MAIL_FROM="ΡΟΔΙΟΣ <verified-sender@example.gr>" FIREBASE_PROJECT_ID=dimosrodou-otp
```

Το `MAIL_FROM` πρέπει να είναι αποστολέας/domain που έχει επαληθευτεί στο Resend. Τα Supabase API keys παρέχονται αυτόματα στις Edge Functions και δεν γράφονται σε `.env` ή στο repository.

## 6. Ρύθμιση εφαρμογής

Στο `config.js` συμπληρώστε μόνο:

```js
supabaseUrl: 'https://NEW_PROJECT_REF.supabase.co',
supabaseAnonKey: 'NEW_PUBLISHABLE_OR_ANON_KEY',
```

Μην βάλετε ποτέ secret/service-role key στο `config.js`.

## 7. Νέο GitHub repository και Pages

Δημιουργήστε κενό public repository με ακριβές όνομα `rodios-aitimata-entoles`. Έπειτα, από τον φάκελο των αρχείων:

```bash
git init
git remote add origin https://github.com/vasilis1730-web/rodios-aitimata-entoles.git
git branch -M main
git add .
git commit -m "Initial isolated Rodios requests and work-orders app"
git push -u origin main
```

Στο νέο repository ανοίξτε Settings → Pages:

- Source: Deploy from a branch
- Branch: `main`
- Folder: `/(root)`

Οι τελικές διαδρομές θα είναι:

- `https://vasilis1730-web.github.io/rodios-aitimata-entoles/aitimata/`
- `https://vasilis1730-web.github.io/rodios-aitimata-entoles/entoles/`

## 8. Υποχρεωτικό λειτουργικό test πριν από κανονική χρήση

1. Συνδεθείτε στην εφαρμογή εντολών ως Administrator.
2. Επιβεβαιώστε ότι δεν υπάρχουν αιτήματα, εντολές ή πληρωμές.
3. Δημιουργήστε αιτήματα 001, 002 και 003. Διαγράψτε το 002 ως Administrator. Το επόμενο πρέπει να γίνει 002.
4. Δημιουργήστε εντολές 001 και 002. Διαγράψτε την 001. Το συνδεδεμένο αίτημα πρέπει να γίνει `Προς ενέργεια` και η επόμενη εντολή 001.
5. Υποβάλετε ένα αίτημα από `/aitimata/` με OTP και επιβεβαιώστε ότι εμφανίζεται στο `/entoles/`.
6. Δοκιμάστε άκυρο πρωτόκολλο. Δεν πρέπει να αποθηκευτεί και πρέπει να επιτρέπεται αμέσως νέα επιλογή αρχείου.
7. Δοκιμάστε PDF με ακριβώς 3 διαφορετικές υπογραφές και τα 3 ονόματα της Επιτροπής. Μόνο τότε πρέπει να ολοκληρωθεί η παραλαβή και να δημιουργηθεί πληρωμή.
8. Στείλτε μία δοκιμαστική εντολή στο δηλωμένο email αναδόχου και ελέγξτε τον σύνδεσμο ολοκλήρωσης.

Μόνο αφού περάσουν και τα οκτώ βήματα χρησιμοποιείται η νέα εγκατάσταση με πραγματικά δεδομένα.

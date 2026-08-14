# Αρχικοποίηση του νέου Supabase

Οι ενέργειες αυτού του φακέλου αφορούν **μόνο το νέο Supabase project**.

## Σωστή σειρά

1. Εκτελέστε, με τη σειρά ονόματος, τα SQL του φακέλου `supabase/migrations/` στο SQL Editor του νέου project.
2. Στο νέο Supabase → Authentication → Users δημιουργήστε τους λογαριασμούς που έδειξε το αναγνωστικό `03_auth_accounts_export.sql`, με τα ίδια email και νέους προσωρινούς κωδικούς.
3. Στο `01_import_reference_data.sql` αντικαταστήστε μόνο το `PASTE_THE_EXPORTED_JSON_HERE` με το JSON που επέστρεψε το αναγνωστικό `01_reference_data_export.sql` του παλιού project.
4. Εκτελέστε το τροποποιημένο `01_import_reference_data.sql` στο **νέο** project.
5. Εκτελέστε το `02_verify_clean_start.sql`. Όλες οι λειτουργικές μετρήσεις πρέπει να είναι `0`.
6. Αναπτύξτε τις Edge Functions του φακέλου `supabase/functions/` στο νέο project.
7. Ορίστε τα secrets `RESEND_API_KEY` και `MAIL_FROM` για την αυτόματη αποστολή email. Το `FIREBASE_PROJECT_ID` είναι προαιρετικό αν παραμένει `dimosrodou-otp`.
8. Αντιγράψτε το νέο Project URL και το νέο anon/public key στο `config.js` του νέου repository.

Μην αντιγράψετε service-role key, παλιούς κωδικούς ή δεδομένα αιτημάτων/εντολών σε κανένα αρχείο του repository.

Οι ακριβείς εντολές deploy, secrets, GitHub Pages και το υποχρεωτικό λειτουργικό test βρίσκονται στο `../../DEPLOYMENT_CHECKLIST.md`.

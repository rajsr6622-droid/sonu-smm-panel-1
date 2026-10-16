# Sonu SMM Panel — setup guide (Hindi)

यह ZIP एक Node.js starter है जिसमें email/password account, optional Google account chooser, service list, order history/status, wallet और Razorpay checkout integration points हैं। **ZIP अपने-आप live/production website नहीं बनाता** और बिना credentials के real Google login, supplier orders या payments नहीं चलेंगे।

## चलाने के लिए
1. Node.js 20+ hosting लें (Render जैसी) और इस folder को GitHub repository में upload करें। ZIP को सीधे repository में upload करने के बजाय extract करके अंदर की files upload करें।
2. Hosting build command: `npm install`; start command: `npm start`.
3. Environment variables को hosting dashboard के Environment section में `.env.example` के अनुसार भरें। असली `.env` या keys GitHub पर कभी upload न करें।
4. `SESSION_SECRET` को लंबा random secret दें।
5. Hanuman SMM supplier dashboard से API key लेकर केवल `SMM_API_KEY` environment variable में डालें। Endpoint `https://hanumansmm.in/api/v2` default है।
6. Google login के लिए Google Cloud Console में OAuth Web Client बनाएं। Authorized redirect URI को ठीक-ठीक `https://YOUR-DOMAIN/auth/google/callback` रखें और `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` भरें। Login में `prompt=select_account` Google account chooser दिखाता है।
7. Razorpay में पहले TEST mode keys भरें: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`; production में webhook secret भी configure करें। अपनी service category के लिए Razorpay की अनुमतियाँ पहले confirm करें।
8. Test account बनाकर login, services, test payment, order status जाँचें। Real customers लेने से पहले security review करें।

## जरूरी production कार्य
- SQLite इस demo starter में है; hosting disk persistence/backups जाँचें और production में managed PostgreSQL की सलाह है।
- Order rate को client/browser से भरोसा करके स्वीकार नहीं करना चाहिए। `/api/orders` में supplier service rate/min/max server-side से validate करें।
- Payment webhook में event reconciliation/idempotency और payment capture verification लागू करें; अभी webhook endpoint signature validate करता है लेकिन wallet credit webhook से नहीं करता।
- Admin panel, password reset, email verification, abuse/rate limits, CSRF protections, refund handling, audit logs, provider failure reconciliation और production monitoring अभी शामिल नहीं हैं।
- किसी भी account के लिए Gmail password नहीं माँगा जाता। Google OAuth इस्तेमाल करें; users का Gmail password आपकी website पर कभी न लें।
- केवल वैध/अनुमत सेवाएँ बेचें और supplier/payment provider के terms का पालन करें।

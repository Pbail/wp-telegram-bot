# WhatsApp Auto-Reply Bot (via Telegram)

Telegram se control hone wala WhatsApp auto-reply bot. Multi-session, MongoDB persisted
sessions (restart/band hone par WhatsApp logout nahi hota), paid-user access system, aur
image/message/file templates.

## Features

- **Owner + Paid Users only** — baaki sabko `Get lost! By @MR_Pbail`
- **Multi WhatsApp session** — ek Telegram user multiple number login kar sakta hai
- **Persistent session (MongoDB RemoteAuth)** — bot restart/crash hone par bhi WhatsApp
  logged in rehta hai
- **Active / Dead session view** — dekho konsa number login hai, konsa logout ho chuka
- **QR login inside Telegram** — QR image seedha chat me aati hai, scan karte hi login
- **Template-based auto reply** — trigger keyword + multiple images + caption + multiple
  files/voice notes
- **Owner payment commands** — `/addpay`, `/removepay`, `/users`

## Setup

1. Node.js 18+ chahiye (fetch API ke liye).
2. Dependencies install karo:
   ```bash
   npm install
   ```
3. `.env.example` ko `.env` me copy karo aur values bharo:
   ```bash
   cp .env.example .env
   ```
   - `BOT_TOKEN` — @BotFather se
   - `MONGO_URI` — MongoDB Atlas / apna MongoDB server (sirf halka metadata ke liye —
     numbers, templates, chat state; WhatsApp ka asal session data yahan nahi jaata)
   - `OWNER_ID` — apni Telegram numeric user ID (e.g. @userinfobot se le lo)
4. Bot chalao:
   ```bash
   npm start
   ```

> Puppeteer (WhatsApp Web ke liye) Linux server par kuch extra system libraries maang
> sakta hai. VPS par deploy karte waqt agar Chromium launch error aaye to
> `apt-get install -y chromium` ya Docker image use karo jisme Chromium pehle se ho.

## WhatsApp Session Storage (Important)

WhatsApp login session ab is server ke **local disk** par store hoti hai
(`wwebjs_auth/` folder, project ke root me), MongoDB me nahi. Isse:

- Restart hone par session **turant aur reliably restore** hoti hai (koi Mongo
  round-trip ya waiting nahi)
- Agar session asal me phone se logout ho chuki thi, wo restart par khud
  **automatically Dead** mark ho jaati hai — dobara login karne ki zaroorat khud
  clearly dikh jaati hai
- MongoDB par sirf halka metadata load hota hai (numbers, templates), heavy session
  data nahi

**Ye folder delete mat karna** jab tak session ko jaan-boojh kar logout na karna ho —
isi me har WhatsApp number ka login state hota hai. Server migrate/redeploy karte
waqt is folder ko bhi sath copy karna, warna sab sessions Dead ho jayengi aur dobara
QR scan karna padega.

`.gitignore` me `wwebjs_auth/` already add hai taake galti se Git me commit na ho
(isme sensitive session data hoti hai).

### Bot ko hamesha `Ctrl+C` se hi band karo

Bot ko band karte waqt (restart, update, deploy) hamesha terminal me **`Ctrl+C`** dabao,
kabhi bhi terminal window force-close ya process ko `kill -9` mat karna. `Ctrl+C` par
bot pehle har WhatsApp session ko *properly* close karta hai (taake session data disk
par poora save ho jaye), phir exit hota hai — is se restart ke baad session turant
reliably restore hoti hai. Agar process ko force-kill kiya jaye (bina graceful shutdown
ke), Chromium beech me hi mar jaata hai aur session corrupt ho sakti hai, jisse dobara
QR scan karna padega.


## Owner Commands

```
/addpay <telegram_id> <24h|7d|30d>   - user ko paid access do
/removepay <telegram_id>             - access hata do
/users                               - saare paid users ki list, expiry ke sath
```

## Bot Flow

1. `/start` → Main Menu (Session / Login Wp / Start Auto Reply)
2. **Session** → Active Session (logout button per number) / Dead Session
3. **Login Wp** → QR image aati hai → scan karo → "Your WP login successful" + number
4. **Start Auto Reply** submenu →
   - **▶️ Start Auto Reply / ⏹ Stop Auto Reply** — toggle button. WhatsApp par kuch bhi
     reply tab tak nahi jayega jab tak ye "Start" na kiya ho (aur ek Active template set
     na ho).
   - **Add New Template** — name (skip-able) → image (multiple) → message/script
     (skip-able) → file/voice (multiple, skip-able — har file add hone ke baad naam
     rename karne ka option milta hai) → finish → "⭐ Set as Active Greeting"
   - **Show All Template** — list dekho (⭐ = active). Tap karke: ⭐ Set Active /
     👁 Preview (bot template ka content Telegram me hi bhej deta hai taake dekh sako
     sahi hai ya nahi) / 🗑 Delete

## Greeting + Auto-Reply Logic

- **Auto Reply chalu hone ke liye do sharte:** (1) Active template set ho, (2) "Start
  Auto Reply" dabaya gaya ho. Dono na ho to WhatsApp par bot chup rahega.
- Jab koi naya WhatsApp contact **pehli baar** message ya call kare → active template
  ki saari images + message + files bhej di jaati hain (ye "greeting").
- Usi contact ka **koi bhi agla** message ya call aaye → bot greeting wale message ko
  **quote karke** sirf `Check this.` reply bhejta hai.

## Log Group

`LOG_GROUP_ID` set karne ke baad in cheezon ki notification us group me aayegi:
- Bot start
- WhatsApp session login / logout / disconnect / restore
- Naya bot visitor (pehli baar Telegram user ne bot ko touch kiya)
- Naya paid user (`/addpay` se)
- Naya WhatsApp contact jisne kisi session par pehli baar message/call kiya
- Naya template create hua (naam, image/file count)
- Auto Reply start/stop kiya gaya
- Koi bhi bot error

## Notes / Assumptions

- File rename sirf files/voice/audio/video ke liye hai, images ke liye nahi (jaisa
  aapne bataya tha).
- Template ki images/files Telegram ke `file_id` se store hoti hain (na ke apne server
  par) — is se koi separate file storage/CDN setup nahi karna padta.
- Ye code apke apne server/VPS par 24/7 chalana hoga (npm start / pm2 / systemd se) taake
  WhatsApp session live rahe.

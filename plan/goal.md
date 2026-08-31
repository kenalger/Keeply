# Mobile App Specification — Personal Life & Expense Manager

## 1. Project Overview

Build a **mobile-first, offline-first personal management app** that combines:

1. Subscription Tracker
2. Bill Reminder
3. Receipt Journal
4. Car / Motorcycle Expense Tracker
5. Document Expiry Tracker

The core principle is:

> **The app must work fully offline. User data should be stored locally on the device by default. Internet connectivity must not be required for the core features.**

Security and privacy are priorities. The app should minimize cloud storage and avoid uploading sensitive personal documents or receipt images by default.

---

# 2. Recommended Technology

## Mobile

Use:

* React Native
* Expo
* TypeScript
* Expo Router
* Zustand or another lightweight state-management solution
* SQLite for persistent local database
* Expo SecureStore for sensitive secrets
* Expo Notifications for reminders
* Expo Camera / Image Picker for receipts and documents
* Expo Local Authentication for Face ID / Touch ID / device authentication

## Local Database

Use:

**SQLite**

The SQLite database is the primary source of truth.

Do NOT use AsyncStorage as the main database.

Use AsyncStorage only for lightweight non-sensitive preferences if necessary.

## Architecture

```text
                MOBILE DEVICE
                     │
        ┌────────────┴────────────┐
        │                         │
    SQLite DB                Local Files
        │                         │
        │                    Photos / PDFs
        │                         │
        └────────────┬────────────┘
                     │
                React Native
                     │
              Offline-first UI
                     │
        ┌────────────┴────────────┐
        │                         │
 Local Notifications        Biometric Lock
```

The app must continue working when:

* Wi-Fi is disabled
* Mobile data is disabled
* The user is in airplane mode
* The backend/cloud service is unavailable

---

# 3. Core Design Principle

Do NOT build this as a traditional cloud-first CRUD application.

Instead:

```text
User Action
    ↓
Update SQLite
    ↓
Update UI
    ↓
Schedule local notification if needed
```

No network request should be required for normal CRUD operations.

If cloud sync is added later:

```text
SQLite
   ↓
Sync Queue
   ↓
Cloud
```

Cloud synchronization should be an optional feature.

---

# 4. Main Navigation

Use bottom-tab navigation.

Tabs:

### Home

Overview/dashboard.

### Money

Subscriptions, bills, receipts.

### Vehicles

Car/motorcycle expenses.

### Documents

Document expiry tracking.

### More

Settings, security, backup, export.

---

# 5. HOME DASHBOARD

The Home screen should immediately show useful information.

Display:

### Monthly Spending

```text
This Month

Subscriptions     ₱1,499
Bills             ₱8,500
Vehicle           ₱3,200
Other             ₱2,100
------------------------
Total             ₱15,299
```

### Upcoming Payments

Example:

```text
Netflix
Due in 3 days
₱549

Internet
Due in 5 days
₱1,899

Car Insurance
Due in 18 days
₱12,000
```

### Upcoming Expirations

Example:

```text
Driver's License
Expires in 42 days

Car Registration
Expires in 74 days
```

### Recent Activity

Show the latest:

* Receipt
* Payment
* Vehicle expense
* Subscription
* Document update

The dashboard must remain useful offline.

---

# 6. SUBSCRIPTION TRACKER

Allow users to track recurring subscriptions.

Examples:

* Netflix
* Spotify
* YouTube Premium
* iCloud
* Gym
* Software
* Memberships

## Subscription fields

```text
id
name
category
amount
currency
billing_cycle
next_billing_date
payment_method
notes
is_active
created_at
updated_at
```

Billing cycles:

* Weekly
* Monthly
* Quarterly
* Yearly
* Custom

## Features

Users can:

* Add subscription
* Edit subscription
* Delete subscription
* Pause subscription
* Mark subscription inactive
* Change billing cycle
* Change renewal date
* Add notes

## Dashboard calculations

Show:

```text
Monthly subscription cost
Yearly subscription cost
Number of active subscriptions
Upcoming renewals
```

For yearly subscriptions, calculate their monthly equivalent.

Example:

```text
₱12,000/year

Monthly equivalent:
₱1,000/month
```

---

# 7. BILL REMINDER

Track recurring bills.

Examples:

* Electricity
* Water
* Internet
* Rent
* Phone
* Insurance
* Credit card
* Other utilities

## Bill fields

```text
id
name
category
amount
currency
due_date
billing_cycle
is_recurring
autopay
notes
created_at
updated_at
```

Allow:

* Fixed amount
* Variable amount

Example:

```text
Electricity

Expected:
₱3,000

Actual:
₱3,450
```

## Payment history

Every bill should have payment records.

```text
Bill
 ├── January   ₱3,100 Paid
 ├── February  ₱3,450 Paid
 ├── March     ₱3,220 Paid
 └── April     ₱3,500 Unpaid
```

Allow the user to mark bills:

* Paid
* Unpaid
* Overdue

---

# 8. LOCAL NOTIFICATIONS

Use device-local notifications.

Do NOT depend on a server to send reminders.

Examples:

```text
"Netflix renews tomorrow — ₱549"

"Internet bill is due in 3 days — ₱1,899"

"Your driver's license expires in 30 days."
```

Allow reminder settings:

* Same day
* 1 day before
* 3 days before
* 7 days before
* 30 days before

The user should be able to configure this globally and per item.

---

# 9. RECEIPT JOURNAL

Users can photograph receipts.

The receipt image should be stored **locally on the device by default**.

Do NOT upload receipt images to your backend.

## Receipt fields

```text
id
merchant
amount
currency
category
purchase_date
payment_method
notes
local_image_uri
created_at
updated_at
```

Categories:

* Food
* Grocery
* Transportation
* Shopping
* Electronics
* Healthcare
* Entertainment
* Household
* Vehicle
* Other

## Receipt workflow

```text
Add Receipt
     ↓
Take Photo
     ↓
Preview
     ↓
Enter / Extract Information
     ↓
Save metadata to SQLite
     ↓
Store image locally
```

The app should work even if the user has no internet connection.

---

# 10. RECEIPT SECURITY

Receipt images may contain:

* Names
* Addresses
* Phone numbers
* Transaction information
* Payment information

Therefore:

* Keep receipt images local.
* Never upload automatically.
* Do not log image paths containing sensitive information.
* Do not include receipt images in analytics.
* Do not send receipts to third-party AI services without explicit user consent.

If cloud backup is eventually implemented, make it:

```text
Settings
   ↓
Cloud Backup
   ↓
User explicitly enables it
```

---

# 11. VEHICLE EXPENSE TRACKER

Support:

* Cars
* Motorcycles

Users can create multiple vehicles.

Example:

```text
My Vehicles

Honda Civic
2022

Yamaha NMAX
2024
```

## Vehicle fields

```text
id
name
make
model
year
plate_number
current_mileage
notes
created_at
updated_at
```

Avoid displaying the full plate number unnecessarily in the UI.

---

# 12. VEHICLE EXPENSES

Track:

### Fuel

```text
date
amount
liters
price_per_liter
odometer
station
notes
```

### Repairs

```text
date
description
amount
odometer
shop
notes
```

### Maintenance

```text
date
type
amount
odometer
next_service_date
next_service_mileage
notes
```

### Insurance

```text
provider
amount
start_date
expiry_date
policy_number
notes
```

### Registration

```text
amount
registration_date
expiry_date
notes
```

---

# 13. VEHICLE ANALYTICS

Calculate:

```text
Total vehicle spending
Monthly vehicle spending
Fuel spending
Maintenance spending
Repair spending
Insurance spending
Registration spending
```

Also calculate:

### Cost per kilometer

Example:

```text
Total vehicle expenses:
₱25,000

Distance:
5,000 km

Cost:
₱5/km
```

For fuel:

```text
Total liters
Total fuel cost
Average price/liter
Average fuel efficiency
```

Only calculate fuel efficiency when sufficient odometer/liter data exists.

---

# 14. DOCUMENT EXPIRY TRACKER

Track important documents.

Examples:

* Passport
* Driver's License
* Government ID
* Insurance
* Vehicle registration
* Certifications
* Memberships

## Document fields

```text
id
name
type
document_number
issue_date
expiry_date
notes
local_file_uri
created_at
updated_at
```

The document number must be treated as sensitive information.

Do not display it unnecessarily.

Mask it when appropriate:

```text
**** **** 1234
```

---

# 15. DOCUMENT EXPIRY ALERTS

Automatically calculate:

```text
Expired
Expires today
Expires in 7 days
Expires in 30 days
Expires in 60 days
Expires in 90 days
```

Example:

```text
⚠ Driver's License

Expires:
October 12, 2026

30 days remaining
```

Use local notifications.

---

# 16. DOCUMENT FILE STORAGE

Document photos/scans should remain local by default.

Do NOT upload passports, IDs, licenses, or other sensitive documents to the backend.

Store only:

```text
SQLite:
document metadata

Device:
actual image/PDF
```

---

# 17. SECURITY

Security must be treated as a first-class feature.

## App Lock

Support:

* Face ID
* Touch ID
* Android Biometric Authentication
* Device PIN/passcode fallback where supported

Example:

```text
Open App
   ↓
Biometric Authentication
   ↓
Home
```

Allow the user to enable/disable app lock.

---

# 18. DATABASE SECURITY

Sensitive data should not be casually exposed.

At minimum:

* Use SQLite.
* Avoid storing unnecessary sensitive data.
* Never store passwords in SQLite.
* Never hard-code encryption keys.
* Never log sensitive information.
* Never include document numbers in analytics.
* Never expose local file paths through logs.

For highly sensitive fields, use encryption.

Consider SQLCipher or another well-maintained encrypted SQLite implementation if supported reliably by the chosen Expo/React Native architecture.

Encryption keys must be stored using:

**iOS Keychain / Android Keystore**

through a secure storage mechanism such as Expo SecureStore.

---

# 19. PRIVACY

The app should follow a privacy-first philosophy.

Default behavior:

```text
Photos       → Device
Documents    → Device
Receipts     → Device
Database     → Device
Analytics    → Minimal / optional
Cloud Sync   → OFF
```

The user should explicitly enable cloud backup/synchronization.

Do not collect unnecessary personal information.

---

# 20. BACKUP / RESTORE

Because the app is offline-first, users need a way to protect their data.

Implement local export/import.

Allow:

```text
Settings
   ↓
Export Data
   ↓
Encrypted Backup File
```

And:

```text
Import Backup
   ↓
Validate
   ↓
Decrypt
   ↓
Restore SQLite data
```

The backup should contain:

* Subscriptions
* Bills
* Payments
* Receipts metadata
* Vehicle data
* Expenses
* Documents metadata
* Settings

For privacy, use an encrypted backup format.

Do not create an unencrypted JSON backup containing sensitive information unless the user explicitly chooses that option.

---

# 21. OPTIONAL CLOUD SYNC — FUTURE FEATURE

Do NOT implement cloud sync in the initial MVP.

Design the database so cloud synchronization can be added later.

Potential architecture:

```text
Local SQLite
     ↓
Sync Queue
     ↓
API
     ↓
Cloud Database
```

Only synchronize structured metadata by default.

For images/documents, allow optional user-controlled backup to:

* iCloud
* Google Drive
* Other supported cloud storage

Do not make your own backend responsible for storing large user media unless necessary.

---

# 22. DATABASE SCHEMA

Create a relational SQLite schema.

Suggested tables:

```text
users
subscriptions
bills
bill_payments
receipts
vehicles
vehicle_expenses
vehicle_maintenance
vehicle_insurance
vehicle_registration
documents
notification_settings
app_settings
```

Use:

```text
UUID / unique IDs
created_at
updated_at
```

for records.

Do not use array/object blobs for everything.

Use relational tables where relationships exist.

---

# 23. SEARCH AND FILTERING

Every major section should support search/filter.

Subscriptions:

* Search
* Category
* Active/inactive

Bills:

* Paid/unpaid
* Upcoming
* Overdue
* Category

Receipts:

* Merchant
* Category
* Date range
* Amount range

Vehicles:

* Vehicle
* Expense type
* Date range

Documents:

* Expiring soon
* Expired
* Category

---

# 24. HOME SCREEN UX

Prioritize information that requires action.

Order:

1. Overdue items
2. Upcoming payments
3. Expiring documents
4. Upcoming subscriptions
5. Monthly spending
6. Recent activity

Avoid overwhelming the user with statistics.

The home screen should answer:

> "Is there anything I need to deal with today?"

---

# 25. OFFLINE-FIRST REQUIREMENTS

Test the application with:

```text
Wi-Fi OFF
Mobile Data OFF
Airplane Mode ON
```

The following must continue working:

* Create records
* Edit records
* Delete records
* View records
* Search
* Filtering
* Dashboard calculations
* Receipt capture
* Document capture
* Vehicle tracking
* Notifications
* Biometric lock
* Export/import

No loading spinner should appear because the app is waiting for a server for normal local operations.

---

# 26. ERROR HANDLING

The application must gracefully handle:

* Missing local files
* Deleted photos
* Corrupted backup files
* Invalid dates
* Invalid amounts
* Duplicate records
* Notification permission denied
* Camera permission denied
* Photo library permission denied
* Biometric unavailable
* Insufficient storage

Never crash because a locally referenced image was deleted.

Show:

```text
Image unavailable
```

instead.

---

# 27. UI DESIGN

Use a clean, modern mobile UI.

Prioritize:

* Large touch targets
* Simple forms
* Minimal typing
* Clear financial numbers
* Clear status indicators
* Dark mode
* Light mode
* Accessible font sizes

Use bottom sheets/modals where appropriate.

Avoid unnecessarily complex dashboards.

---

# 28. ADD ITEM FLOW

Make adding records extremely fast.

Examples:

```text
+ Add

Subscription
Bill
Receipt
Vehicle Expense
Document
```

The user should be able to create common records in under 10–20 seconds.

For receipts:

```text
+ Receipt
    ↓
Camera
    ↓
Amount
    ↓
Category
    ↓
Save
```

---

# 29. VALIDATION

Validate all user input.

Examples:

Amount:

```text
> 0
```

Dates:

```text
Valid calendar date
```

Expiry:

```text
Expiry date cannot be before issue date
```

Vehicle mileage:

```text
>= previous mileage
```

where applicable.

---

# 30. CURRENCY

Initial version:

**PHP (₱)**

Design the database so additional currencies can be supported later.

Do not store formatted strings such as:

```text
"₱1,500.00"
```

Store numeric values:

```text
1500.00
```

and format them only in the UI.

---

# 31. DEVELOPMENT PHASES

## Phase 1 — Foundation

Build:

* Expo project
* TypeScript
* Navigation
* SQLite
* Database migrations
* State management
* Theme system
* Error handling

Deliverable:

A working offline shell.

---

## Phase 2 — Subscriptions

Implement:

* CRUD
* Categories
* Billing cycles
* Monthly/yearly calculations
* Renewal dates
* Local notifications

---

## Phase 3 — Bills

Implement:

* Bills
* Payment history
* Recurring bills
* Due dates
* Paid/unpaid/overdue states
* Notifications

---

## Phase 4 — Receipts

Implement:

* Camera
* Photo library
* Local image storage
* Receipt metadata
* Search
* Filtering
* Spending summaries

---

## Phase 5 — Vehicles

Implement:

* Multiple vehicles
* Fuel
* Repairs
* Maintenance
* Insurance
* Registration
* Mileage
* Vehicle analytics

---

## Phase 6 — Documents

Implement:

* Document CRUD
* Local document/image storage
* Expiry tracking
* Expiry notifications
* Masked sensitive information

---

## Phase 7 — Security

Implement:

* Biometric app lock
* Secure storage
* Database encryption if supported
* Sensitive-data protection
* Privacy settings
* Secure backup/export

---

## Phase 8 — Backup / Restore

Implement:

* Encrypted local backup
* Export
* Import
* Backup validation
* Restore workflow

---

# 32. TESTING

Test every feature under:

### Normal mode

```text
Internet ON
```

### Offline mode

```text
Wi-Fi OFF
Mobile Data OFF
```

### Airplane mode

```text
Airplane Mode ON
```

### Permission scenarios

Test:

* Camera denied
* Photos denied
* Notifications denied
* Biometrics unavailable

### Data scenarios

Test:

* Empty database
* 1 record
* 100 records
* 1,000+ records
* Deleted images
* Expired documents
* Overdue bills

---

# 33. PERFORMANCE

The application should feel instant for local operations.

Target:

```text
Create record:
< 100ms perceived response

Open list:
< 300ms

Search:
instant/local

Dashboard:
calculated locally
```

Use pagination or virtualization for large lists.

Do not load every receipt image into memory simultaneously.

Generate/use thumbnails where appropriate.

---

# 34. SECURITY RULE

Never compromise offline functionality just to simplify backend architecture.

The primary data flow should be:

```text
USER
 ↓
MOBILE APP
 ↓
LOCAL SQLITE
 ↓
LOCAL FILE STORAGE
```

Cloud services are optional additions, not dependencies.

---

# 35. MVP DEFINITION

The first release should contain:

### Dashboard

* Monthly spending
* Upcoming payments
* Upcoming expirations
* Recent activity

### Subscriptions

* CRUD
* Renewal reminders
* Monthly/yearly totals

### Bills

* CRUD
* Payment history
* Due-date reminders

### Receipts

* Camera
* Local photo storage
* Metadata
* Spending summary

### Vehicles

* Vehicle profiles
* Fuel
* Maintenance
* Repairs
* Insurance
* Registration

### Documents

* Document tracking
* Expiry dates
* Local attachments
* Expiry notifications

### Security

* Biometric app lock
* Secure local storage
* Privacy-first defaults

### Backup

* Encrypted export/import

---

# 36. DO NOT BUILD YET

Do not add these during the initial MVP:

* Social networking
* Public profiles
* Chat
* Complex AI
* Cryptocurrency
* Investment tracking
* Banking integrations
* Automatic bank transactions
* Server-side image storage
* Mandatory account creation
* Mandatory internet connection
* Complex cloud synchronization

Keep the first version focused.

---

# 37. SUCCESS CRITERIA

The MVP is successful when a user can install the app, turn on airplane mode, and manage their:

```text
💳 Subscriptions
🧾 Bills
🧾 Receipts
🚗 Vehicles
📄 Documents
```

without needing an internet connection.

The app should feel like a **private personal vault**, not a cloud service.

The core selling point is:

> **Your data stays on your phone. The app works offline. You control your backups.**

Build the project incrementally. Do not implement everything in one step. Start with the database architecture and offline foundation, then implement each module one at a time while keeping the application runnable after every phase.

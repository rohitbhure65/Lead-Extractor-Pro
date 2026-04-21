# Business Requirements Document (BRD)
## Chrome Extension: Lead Extractor Pro

---

## 1. Project Overview

**Project Name:** Lead Extractor Pro
**Project Type:** Chrome Browser Extension
**Core Summary:** A browser extension that enables users to extract, manage, and export leads (names, emails, phone numbers, company details) from websites with keyword-based filtering and deduplication capabilities.
**Target Release:** v1.0.0

---

## 2. Objectives & Goals

### Primary Objectives
- Enable efficient lead data extraction from any webpage
- Provide flexible keyword-based filtering (10-15 custom keywords)
- Support multiple export formats (CSV, Excel)
- Offer lead management capabilities (view, edit, delete, search, filter)
- Ensure data quality through automatic deduplication

### Success Metrics
- Extract leads with >90% accuracy from structured pages
- Support extraction from common sources: LinkedIn, business directories, contact pages
- Process and export 1000+ leads without performance degradation
- Maintain lead data integrity across sessions

---

## 3. Target Users

| User Segment | Use Case |
|--------------|----------|
| **Marketers** | Collect prospect lists for email campaigns |
| **Sales Teams** | Build lead databases from directories |
| **Recruiters** | Extract candidate contact information |
| **Freelancers** | Generate business leads from industry sites |
| **Small Business Owners** | Research competitors and potential clients |

---

## 4. Functional Requirements

### 4.1 Lead Extraction

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-01 | Automatically detect and extract: Name, Email, Phone, Website, Company, Job Title, Address | Must |
| FR-02 | Extract leads from multiple page types: LinkedIn profiles, business listings, contact pages, directories | Must |
| FR-03 | Parse contact information from: mailto: links, tel: links, text patterns, schema.org markup | Must |
| FR-04 | Support extraction across multiple open tabs | Should |
| FR-05 | Process user-provided URLs for extraction | Should |

### 4.2 Manual Keyword-Based Extraction

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-06 | Allow manual input of 10-15 custom keywords | Must |
| FR-07 | Save keyword list for future sessions | Must |
| FR-08 | Filter extracted leads based on keyword matching | Must |
| FR-09 | Keyword matching against: company name, job title, description, website domain | Must |
| FR-10 | Case-insensitive keyword matching | Must |

### 4.3 Export Functionality

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-11 | Export leads to CSV format with proper encoding (UTF-8) | Must |
| FR-12 | Export leads to Excel (.xlsx) format | Must |
| FR-13 | Include all lead fields in export | Must |
| FR-14 | Add timestamp to exported filename | Must |
| FR-15 | Select specific fields to export | Should |

### 4.4 Lead Management Dashboard

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-16 | Display leads in tabular format within popup | Must |
| FR-17 | Edit individual lead fields inline | Must |
| FR-18 | Delete individual leads | Must |
| FR-19 | Search leads by any field | Must |
| FR-20 | Filter leads by keyword/category | Must |
| FR-21 | Sort leads by date extracted, name, company | Must |
| FR-22 | Display total lead count | Must |

### 4.5 Automation Options

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-23 | Start/Stop extraction toggle button | Must |
| FR-24 | Auto-scan current page on demand | Must |
| FR-25 | Option to scan all open tabs | Should |
| FR-26 | Process list of user-provided URLs | Should |
| FR-27 | Show extraction progress indicator | Must |

### 4.6 Data Deduplication

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-28 | Detect duplicate leads by email address | Must |
| FR-29 | Detect duplicate leads by phone number | Must |
| FR-30 | Detect duplicate leads by company+name combination | Should |
| FR-31 | Option to keep first or last occurrence | Should |
| FR-32 | Manual dedupe trigger button | Must |

---

## 5. Non-Functional Requirements

### 5.1 Performance
- Page extraction complete within 3 seconds for typical pages
- UI remains responsive during extraction (async processing)
- Handle 10,000+ leads without UI lag
- Memory usage <200MB during normal operation

### 5.2 Security
- All data stored locally (no external transmission)
- No sensitive data logged or exposed
- User-controlled data deletion
- Clear privacy policy displayed

### 5.3 Scalability
- Support Chrome, Edge, Firefox browsers
- Manifest V3 compliance
- Efficient storage using IndexedDB for large datasets

### 5.4 Compatibility
- Chrome 90+ (Manifest V3)
- Edge 90+ (Chromium-based)
- Firefox 109+ (Manifest V3 support)

### 5.5 Usability
- Single-click extraction workflow
- Intuitive keyword management UI
- Clear extraction status indicators
- Helpful error messages

---

## 6. User Flow & Use Cases

### Primary Use Case: Extract Leads from Business Directory

```
1. User installs extension
2. User opens extension popup
3. User enters 10-15 keywords (e.g., "CEO", "Marketing", "tech startup")
4. User navigates to target website (e.g., LinkedIn, business directory)
5. User clicks "Start Extraction" button
6. Extension scans page for contact information
7. Extension filters results based on keywords
8. Extension removes duplicate leads
9. User reviews leads in dashboard
10. User edits/removes incorrect entries
11. User exports to CSV or Excel
```

### Secondary Use Case: Manual Lead Addition

```
1. User clicks "Add Lead" button
2. User fills in lead details manually
3. Lead saved to storage
4. Lead appears in dashboard
```

### Secondary Use Case: Bulk URL Processing

```
1. User provides list of URLs (one per line)
2. User clicks "Process URLs"
3. Extension opens each URL in sequence (background)
4. Extracts leads from each page
5. Aggregates results with deduplication
6. Notifies user on completion
```

---

## 7. System Architecture

### Chrome Extension Structure

```
lead-extractor-pro/
├── manifest.json           # Extension manifest (Manifest V3)
├── popup/
│   ├── popup.html          # Main popup UI
│   ├── popup.css           # Popup styles
│   └── popup.js            # Popup logic & state management
├── background/
│   └── background.js       # Service worker for extraction tasks
├── content/
│   └── content.js          # Injected script for page parsing
├── libs/
│   ├── xlsx.min.js         # Excel export library
│   └── papaparse.min.js    # CSV export library
├── components/
│   ├── dashboard.js        # Lead management UI
│   ├── keyword-panel.js    # Keyword input management
│   └── export-handler.js   # Export logic
├── utils/
│   ├── extractor.js        # Lead extraction logic
│   ├── deduplicator.js     # Deduplication logic
│   └── storage.js          # IndexedDB wrapper
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### Data Flow

```
[Web Page] → [Content Script] → [Background Script] → [IndexedDB Storage]
                                        ↓
[Popup/Dashboard] ← [Storage API] ← [IndexedDB]
                                        ↓
                              [Export (CSV/Excel)]
```

---

## 8. Tech Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Extension Shell | Chrome Manifest V3 | Required for Chrome Web Store |
| UI Framework | Vanilla JavaScript + CSS3 | Lightweight, no build complexity |
| State Management | Local State + IndexedDB | Persistent storage for leads |
| CSV Export | PapaParse | Robust CSV generation |
| Excel Export | SheetJS (xlsx) | Full Excel format support |
| DOM Parsing | Native DOMParser API | Built-in, no dependencies |
| Pattern Matching | Regex + DOM selectors | Flexible extraction |

---

## 9. UI/UX Requirements

### 9.1 Layout Structure

**Popup View (400x600px)**
```
┌─────────────────────────────────┐
│  Lead Extractor Pro     [⚙] │
├─────────────────────────────────┤
│  ┌─ Keyword Panel ────────────┐│
│  │ Keywords (10-15):           ││
│  │ [_____________________] [+] ││
│  │ #marketing #CEO #tech ...   ││
│  └─────────────────────────────┘│
├─────────────────────────────────┤
│  [▶ Start Extraction]          │
│  [■ Stop] [⟳ Deduplicate]      │
│  Progress: ████████░░ 80%      │
├─────────────────────────────────┤
│  ┌─ Lead Dashboard ────────────┐│
│  │ 🔍 [Search...]     [Filter] ││
│  │─────────────────────────────││
│  │ John Doe | john@... | CEO   ││
│  │ Jane Smith | jane@... | CTO ││
│  │ ...                         ││
│  │ Showing: 45 leads          ││
│  └─────────────────────────────┘│
├─────────────────────────────────┤
│  [📥 Export CSV] [📊 Export XLS]│
│  [🗑 Clear All]                 │
└─────────────────────────────────┘
```

### 9.2 Visual Design

| Element | Specification |
|---------|---------------|
| Primary Color | #4F46E5 (Indigo) |
| Secondary Color | #10B981 (Emerald) |
| Background | #FFFFFF / #1F2937 (Dark mode) |
| Text | #111827 / #F9FAFB (Dark mode) |
| Border | #E5E7EB / #374151 (Dark mode) |
| Error | #EF4444 (Red) |
| Success | #10B981 (Green) |
| Font | System UI (-apple-system, BlinkMacSystemFont, Segoe UI) |
| Radius | 6px (buttons), 8px (cards) |
| Shadow | 0 1px 3px rgba(0,0,0,0.1) |

### 9.3 Component States

| Component | States |
|-----------|--------|
| Buttons | Default, Hover (+5% brightness), Active (scale 0.98), Disabled (opacity 0.5) |
| Input Fields | Default, Focus (ring-2 primary), Error (ring-2 red) |
| Lead Row | Default, Hover (bg-gray-50), Selected (bg-primary-50) |
| Toggle | On (primary), Off (gray) |

---

## 10. Data Storage

### 10.1 Lead Data Model

```javascript
{
  id: string,           // UUID
  name: string,         // Full name
  email: string,        // Email address
  phone: string,        // Phone number
  website: string,      // Website URL
  company: string,      // Company name
  jobTitle: string,     // Job title
  address: string,      // Physical address
  source: string,       // Source URL
  keywords: string[],   // Matched keywords
  createdAt: timestamp, // Extraction timestamp
  updatedAt: timestamp  // Last modified
}
```

### 10.2 Storage Strategy

| Data Type | Storage | Reason |
|-----------|---------|--------|
| Leads | IndexedDB | Large dataset, queryable |
| Keywords | chrome.storage.local | Small, synchronous access needed |
| Settings | chrome.storage.local | User preferences |
| Export History | chrome.storage.local | Quick access |

### 10.3 IndexedDB Schema

```
Database: LeadExtractorDB
├── Store: leads
│   ├── keyPath: id
│   ├── indexes: [email, company, createdAt]
├── Store: settings
│   └── keyPath: key
```

---

## 11. Export Logic

### 11.1 CSV Export

- Encoding: UTF-8 with BOM for Excel compatibility
- Delimiter: Comma (,)
- Quote: Double quotes (") for fields containing comma/quote/newline
- Header: Field names in first row
- Filename: `leads_YYYY-MM-DD_HHmmss.csv`

### 11.2 Excel Export

- Format: .xlsx (Office Open XML)
- Sheet: Single sheet named "Leads"
- Header: Bold formatting
- Column width: Auto-fit content
- Filename: `leads_YYYY-MM-DD_HHmmss.xlsx`

### 11.3 Export Fields (Default Order)

1. Name
2. Email
3. Phone
4. Company
5. Job Title
6. Website
7. Address
8. Source URL
9. Matched Keywords
10. Extracted Date

---

## 12. Permissions Required

### manifest.json Permissions

```json
{
  "permissions": [
    "activeTab",
    "storage",
    "tabs"
  ],
  "host_permissions": [
    "<all_urls>"
  ]
}
```

### Permission Justification

| Permission | Purpose |
|------------|---------|
| activeTab | Extract leads from current page |
| storage | Persist leads and settings |
| tabs | Access tab URLs for source tracking |
| <all_urls> | Read page content for extraction |

---

## 13. Limitations & Risks

### 13.1 Technical Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| Dynamic content (SPA) | May miss data loaded via JS | Content script + MutationObserver |
| CAPTCHA/Anti-bot | Extraction blocked | User notification, manual fallback |
| Iframes | Cannot access cross-origin | Inform user, skip if blocked |
| Password-protected pages | Cannot access | Cannot extract, notify user |
| Rate limiting | Server may block requests | Respect delays, single-page focus |

### 13.2 Legal & Compliance

| Risk | Mitigation |
|------|------------|
| Scraping Terms of Service | Display warning, user responsibility |
| GDPR/Privacy | No external data transmission, user-controlled deletion |
| LinkedIn/Platform ToS | Non-aggressive extraction, educational use |
| Data retention | User can delete all data, no cloud sync |

### 13.3 User Responsibility Disclaimer

> This extension is a tool for collecting publicly available contact information. Users are responsible for ensuring compliance with applicable laws, terms of service, and privacy regulations in their jurisdiction and use case.

---

## 14. Future Enhancements

### Phase 2 (Post-v1.0)

| Feature | Description |
|---------|-------------|
| AI Lead Scoring | Use simple heuristics to score lead quality |
| CRM Integration | Export to Salesforce, HubSpot, Pipedrive |
| Email Verification | Verify email deliverability |
| Cloud Sync | Optional cloud backup (user opt-in) |
| Browser Sync | Sync across Chrome profiles |

### Phase 3 (Post-v1.1)

| Feature | Description |
|---------|-------------|
| Chrome Web Store | Publish for public installation |
| Analytics Dashboard | Lead source statistics |
| Template System | Save keyword filter presets |
| Team Sharing | Share lead lists (requires auth) |

---

## 15. Development Roadmap

### Sprint 1: Foundation
- [ ] Project setup (manifest, build config)
- [ ] Basic popup UI layout
- [ ] Storage layer (IndexedDB)
- [ ] Lead data model

### Sprint 2: Extraction Core
- [ ] Content script for page parsing
- [ ] Lead extraction algorithms
- [ ] Keyword matching logic
- [ ] Background worker setup

### Sprint 3: Dashboard & Management
- [ ] Lead list display
- [ ] Search/filter functionality
- [ ] Inline edit capabilities
- [ ] Delete operations

### Sprint 4: Export & Polish
- [ ] CSV export (PapaParse)
- [ ] Excel export (SheetJS)
- [ ] Deduplication logic
- [ ] UI polish & error handling

### Sprint 5: Testing & Release
- [ ] Cross-browser testing
- [ ] Performance testing (1000+ leads)
- [ ] User acceptance testing
- [ ] Documentation

---

## 16. Acceptance Criteria

### AC-1: Extraction
- [ ] Can extract name, email, phone from a contact page
- [ ] Keywords filter results correctly
- [ ] Extraction completes within 5 seconds

### AC-2: Management
- [ ] Leads persist after browser restart
- [ ] Search returns matching results
- [ ] Edit saves changes correctly

### AC-3: Export
- [ ] CSV opens correctly in Excel
- [ ] Excel export includes all fields
- [ ] Filename includes timestamp

### AC-4: Deduplication
- [ ] Duplicate emails are detected
- [ ] User can trigger dedupe manually
- [ ] Original lead retained after dedupe

### AC-5: UI/UX
- [ ] All buttons respond to clicks
- [ ] Loading states shown during extraction
- [ ] Error messages displayed clearly

---

## Appendix A: Sample Regex Patterns

### Email Detection
```regex
/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
```

### Phone Detection
```regex
/(\+?1?[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g
```

### Website Detection
```regex
/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g
```

---

*Document Version: 1.0*
*Created: April 21, 2026*
*Author: Lead Extractor Pro Team*

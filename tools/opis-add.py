# =============================================================================
# opis-add.py — append dates read in a chat to the date inventory
# (corrections/source-dates.tsv), checking each one against p3k14c by lab number.
# Item С-10 (owner 24.11.2026, variant a): new rows only; old rows are not touched.
#
# Usage:
#   python3 tools/opis-add.py <input.tsv> "<stamp>" [--dry] [--force]
#     <input.tsv>  UTF-8, tab-separated, header row with these columns
#                  (order free; extra columns ignored):
#                    Источник, Стоянка, Дата, Лаб. номер, Культура, Оценка, Учтено
#                  optional: Район, Материал, Кривая (N / S / нет), В базе
#     <stamp>      text for the column «Записано», e.g. "25.11 (чат 7)"
#     --dry        print what would be written, write nothing
#     --force      write even if rows with this stamp are already in the inventory
#
# For each row with a lab number and an age "A ± E":
#   - the number is in p3k14c and age and error agree (±1): a short row —
#     «В базе» = «= база»; district, material and the curve come from the base
#     (unless given), calibration and map windows by tools/c14.mjs;
#   - the number is in p3k14c, but the age or error differ: a full row —
#     «В базе» = «расхождение с базой: база A ± E (site; reference)», calibrated
#     as in the source; the row is listed at the end — put it into the chat
#     write-up (into the item, if it bears on one);
#   - the number is not in p3k14c: as before — «В базе» = «нет».
# Rows without a lab number are written as given (Claude checks by hand only
# the dates that decide an item). Curve: «Кривая» if given (нет = do not
# calibrate: marine shell etc.), else SHCal20 south of the equator (base
# latitude), else IntCal20.
# =============================================================================
import csv, gzip, os, re, subprocess, sys, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INV = os.path.join(ROOT, 'corrections', 'source-dates.tsv')
WINDOWS = (-10000, -8000, -6000, -5000)   # map dates with an inventory window (±250)

args = [a for a in sys.argv[1:] if not a.startswith('--')]
if len(args) != 2:
    sys.exit(__doc__ or 'usage: python3 tools/opis-add.py <input.tsv> "<stamp>" [--dry] [--force]')
SRC, STAMP = args
DRY, FORCE = '--dry' in sys.argv, '--force' in sys.argv

norm = lambda s: re.sub(r'[^A-Z0-9]', '', s.upper())
base = collections.defaultdict(list)
for r in csv.DictReader(gzip.open(os.path.join(ROOT, 'tools/c14-data/p3k14c.csv.gz'), 'rt', encoding='utf-8')):
    try:
        base[norm(r['LabID'])].append(dict(age=float(r['Age']), err=float(r['Error']), lat=float(r['Lat'] or 0), lon=float(r['Long'] or 0),
                                           site=r['SiteName'], ref=r['Reference'], mat=r['Material'], country=r['Country'], prov=r['Province']))
    except ValueError:
        pass

def age_err(text):
    m = re.search(r'(\d[\d\s  ]*)\s*±\s*(\d+)', text)
    if not m: return None
    return float(re.sub(r'\D', '', m.group(1))), float(m.group(2))

def calibrate(age, err, south):
    out = subprocess.run(['node', os.path.join(ROOT, 'tools/c14.mjs'), '--test', f'{age:.0f},{err:.0f}' + (',S' if south else '')],
                         capture_output=True, text=True).stdout.strip().split('\n')[-1]
    m = re.search(r'95 %: (.+?); медиана (\d[\d ]*)', out)
    if not m: return '', '', ''
    nums = [int(x.replace(' ', '')) for x in re.findall(r'\d[\d ]*\d|\d', m.group(1))]
    a, b, med = -(max(nums) - 1950), -(min(nums) - 1950), -(int(m.group(2).replace(' ', '')) - 1950)
    wins = ', '.join(str(y) for y in WINDOWS if a <= y + 250 and b >= y - 250)
    return f'{a} … {b}', str(med), wins

inv_text = open(INV, encoding='utf-8-sig').read()
header = inv_text.split('\n')[0].rstrip('\r').split('\t')
H = {h: i for i, h in enumerate(header)}
stamps = {l.rstrip('\r').split('\t')[H['Записано']] for l in inv_text.split('\n')[1:] if l.count('\t') >= H['Записано']}
if STAMP in stamps and not FORCE:
    sys.exit(f'rows with the stamp "{STAMP}" are already in the inventory (use --force to add more)')

rows_in = list(csv.DictReader(open(SRC, encoding='utf-8-sig'), delimiter='\t'))
out, diffs, stat = [], [], collections.Counter()
for x in rows_in:
    g = lambda k: (x.get(k) or '').strip()
    row = [''] * len(header)
    row[H['Источник']] = g('Источник'); row[H['Стоянка, слой']] = g('Стоянка'); row[H['Район']] = g('Район')
    row[H['Дата как в источнике']] = g('Дата'); row[H['Лаб. номер']] = g('Лаб. номер'); row[H['Материал']] = g('Материал')
    row[H['Культура']] = g('Культура'); row[H['Оценка']] = g('Оценка'); row[H['Учтено']] = g('Учтено'); row[H['Записано']] = STAMP
    curve = g('Кривая').upper()
    ae = age_err(g('Дата'))
    hits = base.get(norm(g('Лаб. номер')), []) if g('Лаб. номер') else []
    south = None
    if not g('Лаб. номер') or not ae:
        row[H['В базе']] = g('В базе'); stat['no lab number or no age'] += 1
    elif not hits:
        row[H['В базе']] = g('В базе') or 'нет'; stat['not in base'] += 1
    else:
        same = [b for b in hits if abs(b['age'] - ae[0]) <= 1 and abs(b['err'] - ae[1]) <= 1]
        b = (same or hits)[0]
        south = b['lat'] < 0
        if same:
            row[H['В базе']] = '= база'; stat['= base'] += 1
            if not row[H['Район']]:
                row[H['Район']] = ', '.join(v for v in (b['prov'], b['country']) if v) + f' ({b["lat"]:.2f} / {b["lon"]:.2f})'
            if not row[H['Материал']]: row[H['Материал']] = b['mat']
        else:
            row[H['В базе']] = 'расхождение с базой: база ' + '; '.join(f'{h["age"]:.0f} ± {h["err"]:.0f} ({h["site"]}; {h["ref"]})' for h in hits[:3])
            stat['discrepancy'] += 1
            diffs.append(f'  {g("Стоянка")} {g("Лаб. номер")}: источник {g("Дата")} — {row[H["В базе"]]}')
    if ae and curve not in ('НЕТ', 'NO'):
        s = {'S': True, 'N': False}.get(curve, south if south is not None else False)
        row[H['Калиброванная, до н. э.']], row[H['Медиана']], row[H['Окна карт']] = calibrate(*ae, s)
    out.append(row)

for k, v in sorted(stat.items()): print(f'{k}: {v}')
if diffs:
    print('discrepancies with p3k14c (put them into the chat write-up):'); print('\n'.join(diffs))
if DRY:
    for r in out: print('\t'.join(r))
    sys.exit()
NL = '\r\n' if '\r\n' in inv_text else '\n'
with open(INV, 'a', encoding='utf-8', newline='') as f:
    if not inv_text.endswith(('\n', '\r\n')): f.write(NL)
    f.write(NL.join('\t'.join(r) for r in out) + NL)
print(f'written: {len(out)} rows → corrections/source-dates.tsv')

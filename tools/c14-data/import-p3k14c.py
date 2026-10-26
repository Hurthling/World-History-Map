# Rebuild p3k14c.csv.gz from the p3k14c R package data (run in any Python 3).
#   pip install rdata pandas
#   git clone --depth 1 https://github.com/people3k/p3k14c
#   python import-p3k14c.py p3k14c/data/p3k14c_data.rda
import sys, rdata, pandas as pd
df = rdata.read_rda(sys.argv[1])['p3k14c_data']
cols = ['LabID','Age','Error','Material','Taxa','Lat','Long','LocAccuracy','SiteName','Country','Province',
        'Continent','Period','Source','Reference']
df = pd.DataFrame({c: df[c] for c in cols})
df = df[df.Age.notna() & df.Error.notna() & df.Lat.notna() & df.Long.notna()]
df.to_csv('p3k14c.csv.gz', index=False, compression={'method': 'gzip', 'compresslevel': 9})
print(len(df), 'dates written')

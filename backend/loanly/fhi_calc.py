"""Sviana – revised Farm Health Index (FHI) calculator.

Usage:  python3 fhi_calc.py sviana_fhi_inputs.csv [--season 10-04] [--analysis-start 2018-07-01]

Revised FHI (fixes to the original equal-weight index):
  1. Every component is a percentile vs the SAME farm and the SAME 8-day period of the year
     (+/- 1 period), so dry regions are not permanently "unhealthy".
  2. Soil moisture is two-sided: above the 85th percentile it is penalised as waterlogging.
  3. FHI is computed only inside the crop season (default Oct–Apr, summer crops).
  4. Validation uses de-seasonalised anomalies and campaign comparisons (e.g. 2022/23 drought),
     not raw correlations between the components.

    VCI_p = percentile of NDVI (MODIS 250 m) in its 8-day slot      [VCI is monotone in NDVI per slot]
    SMp   = percentile of SMAP soil_moisture_am in its slot
    SMp*  = SMp if SMp <= 85 else max(0, 85 - 2*(SMp - 85))
    WA    = min(1, ET/PET);  WA_p = percentile of WA in its slot
    FHI   = mean(VCI_p, SMp*, WA_p)   (needs >= 2 of the 3 components)
"""
import argparse
import numpy as np
import pandas as pd

p = argparse.ArgumentParser()
p.add_argument('csv')
p.add_argument('--season', default='10-04', help='first-last month of crop season, e.g. 10-04')
p.add_argument('--analysis-start', default='2018-07-01')
p.add_argument('--out', default='fhi_results')
a = p.parse_args()

df = pd.read_csv(a.csv).replace(-9999, np.nan)
df['date'] = pd.to_datetime(df['date'])
df = df.sort_values('date').reset_index(drop=True)
df['slot'] = (df['date'].dt.dayofyear - 1) // 8           # MOD16 composites start on DOY 1, 9, 17...
df['WA'] = np.minimum(1.0, df['et'] / df['pet'])
df.loc[(df['pet'] <= 0) | df['pet'].isna(), 'WA'] = np.nan


def slot_percentile(col):
    """Empirical percentile of each value among all years' values in the same slot +/- 1."""
    out = pd.Series(np.nan, index=df.index)
    for s in df['slot'].unique():
        near = df['slot'].isin([(s - 1) % 46, s, (s + 1) % 46])
        ref = df.loc[near, col].dropna().values
        idx = df.index[(df['slot'] == s) & df[col].notna()]
        if len(ref) < 5:
            continue
        for i in idx:
            v = df.at[i, col]
            out[i] = 100 * (np.sum(ref < v) + 0.5 * np.sum(ref == v)) / len(ref)
    return out


def slot_vci(col):
    g = df.groupby('slot')[col]
    mn, mx = g.transform('min'), g.transform('max')
    return 100 * (df[col] - mn) / (mx - mn)


df['VCI'] = slot_vci('ndvi_modis')                 # classic VCI, reported for reference
df['VCI_p'] = slot_percentile('ndvi_modis')
df['SMp'] = slot_percentile('sm')
df['SMp_star'] = np.where(df['SMp'] <= 85, df['SMp'], np.maximum(0, 85 - 2 * (df['SMp'] - 85)))
df.loc[df['SMp'].isna(), 'SMp_star'] = np.nan
df['WA_p'] = slot_percentile('WA')

m0, m1 = [int(x) for x in a.season.split('-')]
mon = df['date'].dt.month
df['in_season'] = ((mon >= m0) | (mon <= m1)) if m0 > m1 else ((mon >= m0) & (mon <= m1))
comp = df[['VCI_p', 'SMp_star', 'WA_p']]
df['FHI'] = np.where(df['in_season'] & (comp.notna().sum(axis=1) >= 2), comp.mean(axis=1), np.nan)
df['campaign'] = np.where(mon >= 7, df['date'].dt.year.astype(str) + '/' + (df['date'].dt.year + 1).astype(str).str[-2:],
                          (df['date'].dt.year - 1).astype(str) + '/' + df['date'].dt.year.astype(str).str[-2:])

an = df[df['date'] >= a.analysis_start].copy()
cols = ['date', 'campaign', 'in_season', 'ndvi_modis', 'ndvi_s2', 'VCI', 'VCI_p', 'sm', 'SMp', 'SMp_star',
        'et', 'pet', 'WA', 'WA_p', 'FHI']
an[cols].to_csv(f'{a.out}_8day.csv', index=False, float_format='%.4f')

seas = (an[an['in_season']].groupby('campaign')
        .agg(n=('FHI', 'count'), FHI=('FHI', 'mean'), VCI_p=('VCI_p', 'mean'), SMp_star=('SMp_star', 'mean'),
             WA_p=('WA_p', 'mean'), FHI_min=('FHI', 'min')).round(1))
seas.to_csv(f'{a.out}_by_campaign.csv')

# De-seasonalised correlations (anomaly vs slot mean), in-season only
anom = pd.DataFrame({c: df[c] - df.groupby('slot')[c].transform('mean')
                     for c in ['ndvi_modis', 'sm', 'WA']})
sel = df['in_season'] & (df['date'] >= a.analysis_start)
corr = anom[sel].corr().round(2)
n = int(anom[sel].dropna().shape[0])
r1 = anom[sel].apply(lambda s: s.autocorr(1)).mean()
n_eff = int(n * (1 - r1) / (1 + r1)) if r1 < 1 else n

print(f'Rows in analysis window: {len(an)}   in-season rows with FHI: {an["FHI"].notna().sum()}')
print('\nSeason means by campaign (Jul–Jun):\n', seas.to_string())
print(f'\nDe-seasonalised correlations (in-season, n={n}, lag-1 autocorr ~{r1:.2f}, effective n ~{n_eff}):')
print(corr.to_string())

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(9, 3.2), dpi=200)
    s = an.set_index('date')['FHI']
    ax.plot(s.index, s.values, color='#2a78d6', lw=1.4)
    for c in ('2022/23',):
        cs = an[an['campaign'] == c]['date']
        if len(cs):
            ax.axvspan(cs.min(), cs.max(), color='#d03b3b', alpha=0.08, lw=0)
            ax.text(cs.min(), 96, f'{c} campaign', fontsize=8, color='#52514e', va='top')
    ax.axhline(50, color='#898781', lw=0.8, ls=(0, (3, 3)))
    ax.set_ylim(0, 100); ax.set_ylabel('FHI (0–100)')
    for sp in ('top', 'right'):
        ax.spines[sp].set_visible(False)
    ax.grid(axis='y', color='#e1e0d9', lw=0.6)
    fig.tight_layout(); fig.savefig(f'{a.out}_timeseries.png')
    print(f'\nSaved {a.out}_8day.csv, {a.out}_by_campaign.csv, {a.out}_timeseries.png')
except Exception as e:
    print('chart skipped:', e)

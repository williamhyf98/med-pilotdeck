# 常用片段速查

只放经过验证的标准写法；版本以 `runtime/requirements.txt` 为准。
所有片段都在 `analysis.sh run` 的脚本里用，路径一律走环境变量。

```python
import os
from pathlib import Path

IN = Path(os.environ["PILOTDECK_ANALYSIS_INPUT"])
OUT = Path(os.environ["PILOTDECK_ANALYSIS_OUT"])
```

## 读文件

```python
import pandas as pd

# CSV：先看编码，中文常见 utf-8-sig / gbk
df = pd.read_csv(IN / "data.csv", encoding="utf-8-sig")

# 大文件：分块，避免一次吃满内存（R2 用例）
total = 0
for chunk in pd.read_csv(IN / "big.csv", chunksize=100_000):
    total += len(chunk)

# Excel：一次读全部工作表名，再按需读
sheets = pd.ExcelFile(IN / "data.xlsx").sheet_names
df = pd.read_excel(IN / "data.xlsx", sheet_name=sheets[0])
```

## 缺失与描述统计

```python
dropped = int(df.isna().any(axis=1).sum())      # 有缺失的行数，写进报告
df = df.dropna(subset=["value"])

desc = df["value"].describe()                    # count/mean/std/min/25%/50%/75%/max
by_group = df.groupby("group")["value"].agg(["count", "mean", "std", "median"])
```

## 两组比较 / 多组比较

```python
from scipy import stats

a = df.loc[df["group"] == "a", "value"]
b = df.loc[df["group"] == "b", "value"]

# 先看正态性（样本量小时用 Shapiro）
normal = stats.shapiro(a).pvalue > 0.05 and stats.shapiro(b).pvalue > 0.05
if normal:
    stat, p = stats.ttest_ind(a, b, equal_var=False)   # Welch t
else:
    stat, p = stats.mannwhitneyu(a, b, alternative="two-sided")

# 多组：单因素方差分析
f_stat, f_p = stats.f_oneway(*[g["value"].to_numpy() for _, g in df.groupby("group")])
```

## 线性回归

```python
import statsmodels.formula.api as smf

model = smf.ols("value ~ age + C(sex)", data=df).fit()
print(model.summary())
```

## 生存分析

```python
from lifelines import KaplanMeierFitter, CoxPHFitter

km = KaplanMeierFitter()
km.fit(df["time"], event_observed=df["event"])
median_survival = float(km.median_survival_time_)

cox = CoxPHFitter()
cox.fit(df[["time", "event", "age", "sex"]], duration_col="time", event_col="event")
```

## 绘图

```python
import matplotlib
matplotlib.use("Agg")
import analysis_plot
analysis_plot.apply()          # 注册随包中文字体 + 统一样式（推荐每次都加）
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(6, 4), dpi=160)
ax.bar(by_group.index, by_group["mean"], yerr=by_group["std"], capsize=3)
ax.set_title("Group means")
ax.set_xlabel("group")
ax.set_ylabel("value")
fig.tight_layout()
fig.savefig(OUT / "figures" / "group-means.png")
```

`analysis_plot` 是技能自带的模块（执行器已把它所在目录放进 `sys.path`）：
它注册随包的 Noto Sans SC，再挑第一个可用的中文字族，返回选了哪个：

```python
import analysis_plot

family = analysis_plot.apply()
print("字体:", family)          # 返回 "DejaVu Sans" 说明这台机器没有中文字体
```

没有 `analysis_plot` 时的退路——自己挑一个**这台机器真的装了**的字体，别写死名字：

```python
from matplotlib import font_manager

CANDIDATES = ["Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Zen Hei",
              "Microsoft YaHei", "Hiragino Sans GB", "Songti SC", "Arial Unicode MS"]
installed = {font.name for font in font_manager.fontManager.ttflist}
picked = [name for name in CANDIDATES if name in installed]

if picked:
    plt.rcParams["font.sans-serif"] = picked + ["DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
# picked 为空：这台机器没有中文字体，图里一律用英文标签（不要硬画中文，会出方框）
```

## 写结果表

```python
by_group.to_csv(OUT / "tables" / "by-group.csv", encoding="utf-8-sig")
```

## DICOM

```python
import pydicom

series = {}
for path in sorted(IN.glob("**/*.dcm")):
    ds = pydicom.dcmread(str(path), stop_before_pixels=True)
    series.setdefault(ds.SeriesInstanceUID, []).append(
        {"file": path.name, "series": ds.get("SeriesDescription", ""), "spacing": ds.get("PixelSpacing")}
    )
```

## ECG / 波形

```python
import wfdb

record = wfdb.rdrecord(str(IN / "100"))     # 不带扩展名
sampling_rate = record.fs
channels = record.sig_name
signal = record.p_signal                      # shape = (采样点数, 通道数)
```

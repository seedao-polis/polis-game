#!/usr/bin/env python3
"""lp_runway.py - LP（生命点）经济续航 / 预算模拟器。

给定一套 LP 经济参数，算出关键续航指标，帮助验证【一次交互扣多少、初始发多少、
补底与签到给多少】是否合理。只做纯计算，不读写任何数据库、不联网、不依赖第三方库。

用法:
    python3 scripts/lp_runway.py --initial 120 --cost 0.3 --floor 10 --checkin 3
    python3 scripts/lp_runway.py --initial 120 --cost 0.1 --daily 30
    python3 scripts/lp_runway.py --cost 0.3 --command quick:0.3 --command deep:1.0

参数:
    --initial   初始发放（新用户初次互动获得），默认 120
    --cost      单次对话扣费，必须 > 0，默认 0.1
    --floor     每日补底值（余额低于它就补到它），默认 10
    --checkin   每日签到额度，默认 3
    --gating    余额不足门槛（低于它就不答）；默认等于 --cost
    --daily     每日预估互动次数（用于估算耗尽天数），默认 30
    --command   形如 name:cost 的计费命令，可重复；列出各自的一次发放续航
"""

import argparse
import sys


def _fmt(x: float) -> str:
    """整数去掉小数尾巴，否则保留一位小数。"""
    return str(int(x)) if abs(x - round(x)) < 1e-9 else f"{x:.1f}"


def runs_until_gating(balance: float, cost: float, gating: float) -> int:
    """从 balance 起、每次扣 cost、扣前余额需 >= gating，能连续对话多少次。
    用一个小 epsilon 抵消浮点误差，避免 119.9/0.1 这类算出少 1 次。"""
    if balance < gating:
        return 0
    return int((balance - gating) / cost + 1e-9) + 1


def parse_commands(items):
    """把 ['quick:0.3', 'deep:1.0'] 解析成 [('quick', 0.3), ('deep', 1.0)]。"""
    out = []
    for raw in items or []:
        if ":" not in raw:
            raise ValueError(f"--command 需为 name:cost 形式，收到: {raw!r}")
        name, _, cost = raw.rpartition(":")
        try:
            c = float(cost)
        except ValueError:
            raise ValueError(f"--command 的 cost 不是数字: {raw!r}")
        if c <= 0:
            raise ValueError(f"--command 的 cost 必须 > 0: {raw!r}")
        out.append((name, c))
    return out


def report(initial, cost, floor, checkin, gating, daily, commands):
    lines = []
    lines.append("LP 经济续航模拟")
    lines.append("=" * 40)
    lines.append("参数：")
    lines.append(f"  初始发放 initial = {_fmt(initial)}")
    lines.append(f"  单次扣费 cost    = {_fmt(cost)}")
    lines.append(f"  每日补底 floor   = {_fmt(floor)}")
    lines.append(f"  每日签到 checkin = {_fmt(checkin)}")
    lines.append(f"  不足门槛 gating  = {_fmt(gating)}")
    lines.append(f"  每日预估互动     = {_fmt(daily)} 次")
    lines.append("")

    # 一次发放续航：从初始一路扣到低于门槛为止。
    once = runs_until_gating(initial, cost, gating)
    # 每日续航：耗尽用户次日靠补底(补到 floor) + 签到(+checkin)。
    daily_budget = max(floor, 0) + max(checkin, 0)
    daily_runs = runs_until_gating(daily_budget, cost, gating)
    # 耗尽天数：每天净消耗 = cost * daily，没有任何补给时初始能撑几天。
    days = initial / (cost * daily) if daily > 0 else float("inf")

    lines.append("结果：")
    lines.append(f"  一次发放续航     = {once} 次（门槛前能连续对话的次数）")
    lines.append(f"  每日续航(耗尽后) = {daily_runs} 次/天（补底 {_fmt(floor)} + 签到 {_fmt(checkin)}）")
    days_str = "∞" if days == float("inf") else f"{days:.1f}"
    lines.append(f"  耗尽天数(无补给) = {days_str} 天（按每日 {_fmt(daily)} 次互动）")
    lines.append("")

    if commands:
        lines.append("计费命令各自的一次发放续航：")
        for name, c in commands:
            n = runs_until_gating(initial, c, gating)
            lines.append(f"  {name:<12} cost={_fmt(c):<5} → {n} 次")
        lines.append("")

    # 简单合理性提示。
    notes = []
    if once < 10:
        notes.append("一次发放续航偏低（<10 次）：初始太少或单次太贵，新人体验可能很紧。")
    if floor > 0 and daily_runs == 0:
        notes.append("每日续航为 0：补底+签到不足一次扣费，耗尽用户次日仍无法对话。")
    if floor == 0 and checkin == 0:
        notes.append("无补底也无签到：用户耗尽后没有任何恢复途径，确认这是有意设计。")
    if notes:
        lines.append("提示：")
        for n in notes:
            lines.append(f"  - {n}")
        lines.append("")

    return "\n".join(lines)


def main(argv=None):
    p = argparse.ArgumentParser(
        description="LP 经济续航 / 预算模拟器（纯计算，不读写数据库）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--initial", type=float, default=120.0, help="初始发放，默认 120")
    p.add_argument("--cost", type=float, default=0.1, help="单次对话扣费，>0，默认 0.1")
    p.add_argument("--floor", type=float, default=10.0, help="每日补底值，默认 10")
    p.add_argument("--checkin", type=float, default=3.0, help="每日签到额度，默认 3")
    p.add_argument("--gating", type=float, default=None, help="余额不足门槛，默认等于 --cost")
    p.add_argument("--daily", type=float, default=30.0, help="每日预估互动次数，默认 30")
    p.add_argument("--command", action="append", default=[], help="计费命令 name:cost，可重复")
    args = p.parse_args(argv)

    if args.cost <= 0:
        p.error("--cost 必须 > 0")
    if args.daily < 0:
        p.error("--daily 不能为负")
    gating = args.cost if args.gating is None else args.gating

    try:
        commands = parse_commands(args.command)
    except ValueError as e:
        p.error(str(e))

    print(report(args.initial, args.cost, args.floor, args.checkin, gating, args.daily, commands))
    return 0


if __name__ == "__main__":
    sys.exit(main())

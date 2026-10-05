#ifndef OFFLINE_COPILOT_H
#define OFFLINE_COPILOT_H

#ifdef __cplusplus
extern "C" {
#endif

// 接口说明:
// input: 包含 4 个浮点数的数组 [smoke, temp, rate, is_blocked]
// 返回值: 0.0 代表 PASS (通行), 1.0 代表 BLOCK (封门/换路)
double run_offline_ai(double* input);

#ifdef __cplusplus
}
#endif

#endif // OFFLINE_COPILOT_H

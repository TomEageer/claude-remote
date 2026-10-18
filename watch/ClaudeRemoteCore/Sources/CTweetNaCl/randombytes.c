// tweetnacl 需要调用方提供随机数：Apple 平台直接用系统的 arc4random_buf（密码学安全）
#include <stdlib.h>
typedef unsigned char u8;
typedef unsigned long long u64;
void randombytes(u8 *x, u64 n) { arc4random_buf(x, (size_t)n); }

// 分词器的测试场景清单。
//
// 这些是测试语料，不是分词器的能力，所以它们住在 tests/ 而不是 lib/：
// 生产模块导出一份永远只有测试用的常量，等于给打包产物塞了一份无人使用的
// 字符串表，也让「lib 里每个 export 都有业务调用方」这条自查失效。

/**
 * Test cases for different scenarios
 */
export const TEST_CASES = [
  {
    input: '人工智能是一种技术',
    description: '纯中文短句',
  },
  {
    input: '2026-11-05 AI 技术在快速发展',
    description: '混合日期、英文缩写和中文',
  },
  {
    input: 'Qwen3-Embedding 在 2026 年发布',
    description: '混合产品名、年份和中文',
  },
  {
    input: 'user@example.com 访问 https://example.com',
    description: '邮箱和 URL',
  },
]

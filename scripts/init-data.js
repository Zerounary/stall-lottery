const db = require('../db');

(async () => {
  await db.init();

  const owners = [
    // 蔬菜摊：覆盖多份认购（2~4个）
    { name: '张三', idCard: 'ID001', stallType: '蔬菜摊', sellClass: '自产', qty: 2 },
    { name: '周芸', idCard: 'ID006', stallType: '蔬菜摊', sellClass: '贩销', qty: 3 },
    { name: '黄一', idCard: 'ID011', stallType: '蔬菜摊', sellClass: '自产', qty: 1 },

    // 肉摊：有人多类型、有人单类型
    { name: '张三', idCard: 'ID001', stallType: '肉摊', sellClass: '猪肉', qty: 1 },
    { name: '李四', idCard: 'ID002', stallType: '肉摊', sellClass: '牛肉', qty: 2 },
    { name: '王华', idCard: 'ID007', stallType: '肉摊', sellClass: '羊肉', qty: 1 },

    // 花车：含大量连续摊位测试
    { name: '李四', idCard: 'ID002', stallType: '花车', sellClass: '鲜花', qty: 1 },
    { name: '陈晨', idCard: 'ID008', stallType: '花车', sellClass: '盆栽', qty: 4 },

    // 车载摊位：极端大 qty（5）测试
    { name: '王五', idCard: 'ID003', stallType: '车载摊位', sellClass: '百货', qty: 5 },
    { name: '赵六', idCard: 'ID004', stallType: '车载摊位', sellClass: '水果', qty: 1 },

    // 展销摊位：多人 + 与其他类型交叉
    { name: '赵六', idCard: 'ID004', stallType: '展销摊位', sellClass: '服装', qty: 2 },
    { name: '钱七', idCard: 'ID005', stallType: '展销摊位', sellClass: '特产', qty: 3 },
    { name: '周芸', idCard: 'ID006', stallType: '展销摊位', sellClass: '小吃', qty: 1 },
  ];

  await db.insertOwnersBulk(owners);
  await db.syncStallClassStats();
  console.log('初始化数据完成, stall_class Stats Synced');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

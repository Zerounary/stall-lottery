const db = require('../db');

(async () => {
  await db.init();

  const owners = [
    // 蔬菜摊：覆盖多份认购（2~4个）
    { name: '张三', idCard: 'ID001', stallType: '蔬菜摊', qty: 2 },
    { name: '周芸', idCard: 'ID006', stallType: '蔬菜摊', qty: 3 },
    { name: '黄一', idCard: 'ID011', stallType: '蔬菜摊', qty: 1 },

    // 肉摊：有人多类型、有人单类型
    { name: '张三', idCard: 'ID001', stallType: '肉摊', qty: 1 },
    { name: '李四', idCard: 'ID002', stallType: '肉摊', qty: 2 },
    { name: '王华', idCard: 'ID007', stallType: '肉摊', qty: 1 },

    // 花车：含大量连续摊位测试
    { name: '李四', idCard: 'ID002', stallType: '花车', qty: 1 },
    { name: '陈晨', idCard: 'ID008', stallType: '花车', qty: 4 },

    // 车载摊位：极端大 qty（5）测试
    { name: '王五', idCard: 'ID003', stallType: '车载摊位', qty: 5 },
    { name: '赵六', idCard: 'ID004', stallType: '车载摊位', qty: 1 },

    // 展销摊位：多人 + 与其他类型交叉
    { name: '赵六', idCard: 'ID004', stallType: '展销摊位', qty: 2 },
    { name: '钱七', idCard: 'ID005', stallType: '展销摊位', qty: 3 },
    { name: '周芸', idCard: 'ID006', stallType: '展销摊位', qty: 1 },
  ];

  await db.insertOwnersBulk(owners);
  console.log('初始化数据完成');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

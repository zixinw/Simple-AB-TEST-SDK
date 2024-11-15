const fs = require('fs');
const crypto = require('crypto');
const csv = require('csv-parser');
const { parse } = require('json2csv');

class ABTestSDK {
    constructor() {
        this.layerTraffic = new Map(); // 存储实验层的流量分配
        this.experimentGroups = new Map(); // 存储实验组及其流量比例和参数
    }

    // 添加实验组及其流量比例和参数
    addExperimentGroup(layerId, experimentId, groupParams) {
        const key = `${layerId}_${experimentId}`;
        this.experimentGroups.set(key, groupParams);
    }

    // 设置实验层的流量比例和桶号，确保流量互斥
    setLayerTraffic(layerId, experimentId, ratio, bucketRanges = null) {
        if (!this.layerTraffic.has(layerId)) {
            this.layerTraffic.set(layerId, new Map());
        }

        const experiments = this.layerTraffic.get(layerId);

        // 获取已使用的桶号
        const usedBuckets = Array.from(experiments.values()).flatMap(exp => exp.buckets || []);
        const availableBuckets = Array.from({ length: 100 }, (_, i) => i + 1).filter(
            bucket => !usedBuckets.includes(bucket)
        );

        let bucketsSet = new Set();

        if (bucketRanges) {
            // 校验用户指定的桶号是否有效且不重复

            for (const range of bucketRanges) {
                const [start, end] = range.split('-').map(Number);
                  // 检查格式和范围有效性
                if (isNaN(start) || isNaN(end) || start < 1 || end > 100 || start > end) {
                    throw new Error(`无效的桶号范围: ${range}`);
                }

                // 检查是否有重叠桶号
                for (let bucket = start; bucket <= end; bucket++) {
                    if (bucket < 1 || bucket > 100) { 
                        throw new Error(`桶号 ${bucket} 必须在 1 到 100 之间`);
                    }
                    if (usedBuckets.includes(bucket)) {
                        throw new Error(`桶号 ${bucket} 已被使用，不能重复`);
                    }
                    if (bucketsSet.has(bucket)) {
                        throw new Error(`桶号 ${bucket} 在多个范围中重复`);
                    }
                    bucketsSet.add(bucket);
                }
            }
        } else {
            // 自动分配桶号，根据实验的流量比例选择合适数量的桶
            const requiredBuckets = Math.ceil(ratio * 100);
            if (requiredBuckets > availableBuckets.length) {
                throw new Error(`可用的桶号不足，无法为实验 ${experimentId} 分配 ${requiredBuckets} 个桶`);
            }

            // 按顺序选择指定数量的桶
            for (let i = 0; i < requiredBuckets; i++) {
                bucketsSet.add(availableBuckets[i]);
            }

            // // 随机选择指定数量的桶(服务器重启会导致用户跳组)
            // while (bucketsSet.size < requiredBuckets) {
            //     const randomIndex = Math.floor(Math.random() * availableBuckets.length);
            //     bucketsSet.add(availableBuckets.splice(randomIndex, 1)[0]);
            // }
        }

        // 记录实验及其使用的桶号
        experiments.set(experimentId, { ratio, buckets: [...bucketsSet] });

        console.log(`实验 ${experimentId} 使用了桶号: ${[...bucketsSet].join(', ')}`);
    }   

    // // 设置实验层的流量比例和桶号，确保流量互斥
    // setLayerTraffic(layerId, experimentId, ratio, bucketRanges) {
    //     if (!this.layerTraffic.has(layerId)) {
    //         this.layerTraffic.set(layerId, new Map());
    //     }

    //     const experiments = this.layerTraffic.get(layerId);
        
    //     // 检查桶号范围是否有效且不重复
    //     const usedBuckets = Array.from(experiments.values()).flatMap(exp => exp.buckets || []);
    //     const bucketsSet = new Set();

    //     for (const range of bucketRanges) {
    //         const [start, end] = range.split('-').map(Number);
    //         for (let bucket = start; bucket <= end; bucket++) {
    //             if (bucket < 1 || bucket > 100) {
    //                 throw new Error(`桶号 ${bucket} 必须在1到100之间`);
    //             }
    //             if (usedBuckets.includes(bucket)) {
    //                 throw new Error(`桶号 ${bucket} 已被实验 ${experimentId} 使用，不能重复使用`);
    //             }
    //             bucketsSet.add(bucket);
    //         }
    //     }

    //     // 记录实验及其使用的桶号
    //     experiments.set(experimentId, { ratio, buckets: [...bucketsSet] });
    // }

    // 获取用户的分组结果
    getUserGroup(layerId, userId) {
        const experiments = this.layerTraffic.get(layerId);
        if (!experiments) {
            return { userId, selectedExperiment: '无实验可用', selectedGroup: null, param: null };
        }

        // 第一次哈希：决定用户是否进入实验
        const firstHash = this.hash(layerId + userId);
        const userBucket = firstHash % 100 + 1; // 生成1到100的桶号
        let selectedExperiment = null;

        // 确定用户进入哪个实验（根据桶）
        for (const [experimentId, { buckets }] of experiments) {
            if (buckets.includes(userBucket)) {
                selectedExperiment = experimentId;
                break;
            }
        }

        if (!selectedExperiment) {
            return { userId, selectedExperiment: '未进入任何实验', selectedGroup: null, param: null };
        }

        // 获取分组
        const groupKey = `${layerId}_${selectedExperiment}`;
        const groupParams = this.experimentGroups.get(groupKey);

        // 第二次哈希：使用用户 ID 和实验 ID 确定分组
        const secondHash = this.hash(selectedExperiment + userId);
        const totalGroupRatio = Object.values(groupParams).reduce((sum, { ratio }) => sum + ratio, 0);
        const groupRandomValue = (secondHash % 100) / 100 * totalGroupRatio;

        // 将实验组按组名进行排序
        const sortedGroups = Object.entries(groupParams).sort((a, b) => a[0].localeCompare(b[0]));

        let cumulativeRatio = 0;
        let selectedGroup = '未知组';
        let selectedParam = null;

        for (const [group, { ratio, param }] of sortedGroups) {
            cumulativeRatio += ratio;
            if (groupRandomValue <= cumulativeRatio) {
                selectedGroup = group;
                selectedParam = param;
                break;
            }
        }

        return { userId, selectedExperiment, selectedGroup, param: selectedParam };
    }

    // 使用 SHA-256 哈希函数
    hash(input) {
        return parseInt(crypto.createHash('sha256').update(input).digest('hex').slice(0, 8), 16);
    }
}

// 测试分组稳定性
function testGroupStability(sdk, layerId, userId, iterations) {
    const results = new Set();

    for (let i = 0; i < iterations; i++) {
        const result = sdk.getUserGroup(layerId, userId);
        results.add(JSON.stringify(result)); // 将结果转为字符串并存入 Set
    }

    console.log('---稳定性测试--');

    console.log(`用户 ID: ${userId}`);
    console.log(`测试迭代次数: ${iterations}`);
    console.log(`分组结果:`);
    results.forEach(res => console.log(res));

    // 检查结果是否一致
    if (results.size === 1) {
        console.log("分组结果稳定，所有迭代的结果一致。");
    } else {
        console.log("分组结果不稳定，存在不同的分组结果。");
    }
}

 // 从文件读取用户ID并进行实验分组
 async function processUserIds(abTestSDK, layerId,inputFile, outputFile) {
    console.log('---随机分组测试--');

    const results = [];
    // 统计参与分组的用户数量
    const experimentGroupCounts = {}; // 用于统计每个实验组或对照组的用户数量

    // 读取用户ID TXT文件
    fs.readFile(inputFile, 'utf8', (err, data) => {
        if (err) {
            console.error('读取文件出错:', err);
            return;
        }

        const userIds = data.split('\n').filter(Boolean); // 按行分割并过滤空行

        userIds.forEach(userId => {
            const result = abTestSDK.getUserGroup(layerId, userId.trim());
            results.push(result);

            const { selectedExperiment, selectedGroup } = result;

            // 初始化统计对象
            if (!experimentGroupCounts[selectedExperiment]) {
                experimentGroupCounts[selectedExperiment] = {};
            }
            if (!experimentGroupCounts[selectedExperiment][selectedGroup]) {
                experimentGroupCounts[selectedExperiment][selectedGroup] = 0;
            }
    
            // 统计实验组或对照组人数
            experimentGroupCounts[selectedExperiment][selectedGroup]++;
        });

        // 输出参与分组的用户总数
        console.log(`共有 ${userIds.length} 位用户参与分组。`);

        // 输出每个实验的各分组人数
        for (const [experiment, groupCounts] of Object.entries(experimentGroupCounts)) {
            console.log(`实验 ${experiment}:`);
            for (const [group, count] of Object.entries(groupCounts)) {
                console.log(`  分组 ${group}: ${count} 位用户`);
            }
        }

        // 将结果写入TXT文件
        const title = 'UserId,SelectedExperiment,SelectedGroup, Param\n'
        const output = results.map(r => `${r.userId},${r.selectedExperiment},${r.selectedGroup},${r.param}`).join('\n');

        fs.writeFile(outputFile, title + output, (err) => {
            if (err) {
                console.error('写入文件出错:', err);
            } else {
                console.log(`分组结果已保存到 ${outputFile}`);
            }
        });
    });
}


async function processUserIdsWithCsv(abTestSDK, layerId, inputFilePath, outputFilePath) {
    const results = [];

    fs.createReadStream(inputFilePath, { encoding: 'utf8' })
        .on('data', (chunk) => {
            // 去除 BOM 字符
            if (chunk.charCodeAt(0) === 0xFEFF) {
                chunk = chunk.slice(1);
            }
        })
        .pipe(csv({ headers: ['first_id', 'second_id', '$first_traffic_source_type', '$first_browser_language'] }))
        .on('data', (row) => {
            try{
                console.log(row);
                console.log(Object.keys(row));
                console.log(row.first_id);
                console.log(row.second_id);
                console.log(row['$first_traffic_source_type']);
                const userId =  row['first_id'] || row.first_id; // 获取用户ID
                const {selectedExperiment, selectedGroup} = abTestSDK.getUserGroup(layerId, userId); // 分配实验组
    
                // 添加实验信息到结果中
                results.push({
                    ...row,
                    experiment_id: selectedExperiment,
                    experiment_group_id: selectedGroup
                });
            }
            catch(error){
                console.error(`处理用户ID ${row['userid']} 时出错:`, error);
            }
        })
        .on('end', () => {
            // 将结果转换为 CSV 格式并写入文件
            const csvData = parse(results);
            fs.writeFileSync(outputFilePath, csvData);
            console.log('用户数据处理完成，并写入新文件');
        });
}


// 示例使用 SDK
const abTestSDK = new ABTestSDK();

// 设置实验层流量比例和桶号，确保不同实验互斥
abTestSDK.setLayerTraffic("search_exp", "Exact_match_test", 0.3, ['1-10','41-60']); // 实验A占30%，使用桶1到30
// abTestSDK.setLayerTraffic("search_exp", "Exact_match_test", 0.3, ['1-30']); // 实验A占30%，使用桶1到30
abTestSDK.setLayerTraffic("search_exp", "Spellcheck", 0.2, ['11-30']); // 实验B占20%，使用桶31到60
// abTestSDK.setLayerTraffic("search_exp", "Spellcheck", 0.3, ['31-60']); // 实验B占20%，使用桶31到60

// 设置实验组参数及流量比例
abTestSDK.addExperimentGroup("search_exp", "Exact_match_test", {
    Exact_match_test_test1: { ratio: 3, param: 'show_excat_match' }, // 实验组 33%
    Exact_match_test_control1: { ratio: 6, param: 'default' },  // 空白对照1 33%
    Exact_match_test_control2: { ratio: 1, param: 'default' }  // 空白对照2 33%
});

abTestSDK.addExperimentGroup("search_exp", "Spellcheck", {
    Spellcheck_test: { ratio: 0.33, param: 'enable_auto_spell_check' }, //实验组 33% 
    Spellcheck_control1: { ratio: 0.33, param: 'without_auto_spell_check' },  // 空白对照1 33%
    Spellcheck_control2: { ratio: 0.33, param: 'without_auto_spell_check' }  // 空白对照2 33%
});

// 运行稳定性测试
const userIdToTest = "1306810399759"; // 测试的用户ID
const testIterations = 10; // 测试迭代次数
testGroupStability(abTestSDK, "search_exp", userIdToTest, testIterations);
// processUserIds(abTestSDK,'search_exp', 'UserId.txt', 'user_group.csv');

processUserIdsWithCsv(abTestSDK,"search_exp",'Userid-1.csv', 'userid-1-group.csv' )


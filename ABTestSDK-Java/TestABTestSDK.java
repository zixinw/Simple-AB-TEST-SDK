import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class TestABTestSDK {
    // 读取用户ID并进行实验分组
    public void processUserIds(ABTestSDK sdk, String layerId, String inputFile, String outputFile)
            throws IOException, NoSuchAlgorithmException {
        List<String> userIds = Files.readAllLines(Paths.get(inputFile));
        List<UserGroupResult> results = new ArrayList<>();

        Map<String, Map<String, Integer>> experimentGroupCounts = new HashMap<>();

        for (String userId : userIds) {
            UserGroupResult result = sdk.getUserGroup(layerId, userId.trim());
            results.add(result);

            String experiment = result.getSelectedExperiment();
            String group = result.getSelectedGroup();

            experimentGroupCounts.putIfAbsent(experiment, new HashMap<>());
            experimentGroupCounts.get(experiment).merge(group, 1, Integer::sum);
        }

        System.out.println("共有 " + userIds.size() + " 位用户参与分组。");
        for (Map.Entry<String, Map<String, Integer>> entry : experimentGroupCounts.entrySet()) {
            System.out.println("实验 " + entry.getKey() + ":");
            entry.getValue().forEach((group, count) -> System.out.println("  分组 " + group + ": " + count + " 位用户"));
        }

        try (BufferedWriter writer = Files.newBufferedWriter(Paths.get(outputFile))) {
            writer.write("UserId,SelectedExperiment,SelectedGroup,Param\n");
            for (UserGroupResult result : results) {
                writer.write(String.format("%s,%s,%s,%s\n", result.getUserId(), result.getSelectedExperiment(),
                        result.getSelectedGroup(), result.getParam()));
            }
        }
    }

    public void processUserIdsWiCSV(ABTestSDK sdk, String layerId, String inputFile, String outputFile)
            throws NoSuchAlgorithmException {
        List<String[]> results = new ArrayList<>();

        // 读取输入文件
        try (BufferedReader reader = new BufferedReader(new FileReader(inputFile))) {
            String line;
            // 读取 CSV 文件的标题行
            String headerLine = reader.readLine();
            results.add(headerLine.split(",")); // 添加标题到结果中

            // 处理每一行
            while ((line = reader.readLine()) != null) {
                String[] columns = line.split(",");
                String userId = columns[0].trim(); // 假设 userId 在第一列

                // 获取用户的实验组信息
                UserGroupResult userGroup = sdk.getUserGroup(layerId, userId);
                String experimentId = userGroup.getSelectedExperiment();
                String experimentGroupId = userGroup.getSelectedGroup();

                // 将结果添加到结果列表中
                String[] resultRow = new String[columns.length + 2];
                System.arraycopy(columns, 0, resultRow, 0, columns.length);
                resultRow[columns.length] = experimentId; // 新增实验 ID 列
                resultRow[columns.length + 1] = experimentGroupId; // 新增实验组 ID 列
                results.add(resultRow);
            }
        } catch (IOException e) {
            e.printStackTrace(); // 处理文件读取异常
        }

        // 写入输出文件
        try (BufferedWriter writer = new BufferedWriter(new FileWriter(outputFile))) {
            for (String[] result : results) {
                writer.write(String.join(",", result));
                writer.newLine();
            }
            System.out.println("用户数据处理完成，并写入新文件: " + outputFile);
        } catch (IOException e) {
            e.printStackTrace(); // 处理文件写入异常
        }
    }

    public void testGroupStability(ABTestSDK sdk, String layerId, String userId) throws NoSuchAlgorithmException {
        // 记录实验组结果
        Set<String> groupResults = new HashSet<>();
        int testRounds = 10; // 设置测试轮数

        for (int i = 0; i < testRounds; i++) {
            UserGroupResult userGroup = sdk.getUserGroup(layerId, userId.trim());
            String selectedGroup = userGroup.getSelectedGroup();
            groupResults.add(selectedGroup);

            // 输出每次分组的结果
            System.out.println("第 " + (i + 1) + " 次分组: " + selectedGroup);
        }

        // 检查分组结果的稳定性
        if (groupResults.size() == 1) {
            System.out.println("用户 " + userId + " 的分组结果稳定，始终为: " + groupResults.iterator().next());
        } else {
            System.out.println("用户 " + userId + " 的分组结果不稳定，共分配了 " + groupResults.size() + " 个不同的组。");
        }
    }

    public static void main(String[] args) throws Exception {
        ABTestSDK sdk = new ABTestSDK();

        sdk.setLayerTraffic("search_exp", "Exact_match_test", 0.3, Arrays.asList("1-30"));
        // sdk.setLayerTraffic("search_exp", "Spellcheck", 0.5,
        // Arrays.asList("51-100"));

        Map<String, GroupParams> exactMatchParams = new HashMap<>();
        exactMatchParams.put("test1", new GroupParams(0.4, "show_exact_match"));
        exactMatchParams.put("control1", new GroupParams(0.4, "default"));
        exactMatchParams.put("control2", new GroupParams(0.2, "default"));
        sdk.addExperimentGroup("search_exp", "Exact_match_test", exactMatchParams);

        TestABTestSDK test = new TestABTestSDK();
        test.processUserIdsWiCSV(sdk, "search_exp", "Userid-1.csv", "Userid-1-group-java.csv");
        // new TestABTestSDK().processUserIds(sdk, "search_exp", "UserId.txt",
        // "user_group.csv");
    }
}

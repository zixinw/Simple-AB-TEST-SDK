import java.security.*;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

public class ABTestSDK {
    private final Map<String, Map<String, Experiment>> layerTraffic = new HashMap<>(); // 实验层流量配置
    private final Map<String, Map<String, GroupParams>> experimentGroups = new HashMap<>(); // 实验组参数

    // 添加实验组及其参数
    public void addExperimentGroup(String layerId, String experimentId, Map<String, GroupParams> groupParams) {
        String key = layerId + "_" + experimentId;
        experimentGroups.put(key, groupParams);
    }

    // 设置实验层流量比例和桶号，确保流量互斥
    public void setLayerTraffic(String layerId, String experimentId, double ratio, List<String> bucketRanges) {
        layerTraffic.putIfAbsent(layerId, new HashMap<>());

        Map<String, Experiment> experiments = layerTraffic.get(layerId);
        Set<Integer> usedBuckets = experiments.values().stream()
                .flatMap(exp -> exp.getBuckets().stream())
                .collect(Collectors.toSet());

        Set<Integer> bucketsSet = new HashSet<>();

        if (bucketRanges != null) {
            // 校验桶号范围是否合法且不重复
            for (String range : bucketRanges) {
                String[] parts = range.split("-");
                int start = Integer.parseInt(parts[0]);
                int end = Integer.parseInt(parts[1]);

                if (start < 1 || end > 100 || start > end) {
                    throw new IllegalArgumentException("无效的桶号范围: " + range);
                }

                for (int bucket = start; bucket <= end; bucket++) {
                    if (usedBuckets.contains(bucket) || bucket < 1 || bucket > 100) {
                        throw new IllegalArgumentException("桶号 " + bucket + " 已被使用或无效");
                    }
                    bucketsSet.add(bucket);
                }
            }
        } else {
            // 自动分配桶号
            int requiredBuckets = (int) Math.ceil(ratio * 100);
            List<Integer> availableBuckets = getAvailableBuckets(usedBuckets);

            if (requiredBuckets > availableBuckets.size()) {
                throw new IllegalArgumentException("可用的桶号不足，无法分配");
            }

            // Collections.shuffle(availableBuckets); // 注释掉该行，避免随机导致的跳组问题
            bucketsSet.addAll(availableBuckets.subList(0, requiredBuckets));
        }

        experiments.put(experimentId, new Experiment(ratio, bucketsSet));
        System.out.println("实验 " + experimentId + " 使用了桶号: " + bucketsSet);
    }

    // 获取用户的分组结果
    public UserGroupResult getUserGroup(String layerId, String userId) throws NoSuchAlgorithmException {
        Map<String, Experiment> experiments = layerTraffic.get(layerId);
        if (experiments == null) {
            return new UserGroupResult(userId, "无实验可用", null, null);
        }

        int userBucket = (hash(layerId + userId) % 100) + 1;
        String selectedExperiment = null;

        for (Map.Entry<String, Experiment> entry : experiments.entrySet()) {
            if (entry.getValue().getBuckets().contains(userBucket)) {
                selectedExperiment = entry.getKey();
                break;
            }
        }

        if (selectedExperiment == null) {
            return new UserGroupResult(userId, "未进入任何实验", null, null);
        }

        String groupKey = layerId + "_" + selectedExperiment;
        Map<String, GroupParams> groupParams = experimentGroups.get(groupKey);

        if (groupParams == null) {
            return new UserGroupResult(userId, selectedExperiment, "未配置实验分组", null);
        }

        // 按组名排序，保证分组结果不受配置顺序影响
        List<Map.Entry<String, GroupParams>> sortedGroups = groupParams.entrySet()
                .stream()
                .sorted(Map.Entry.comparingByKey())
                .toList();

        int secondHash = hash(selectedExperiment + userId);
        double totalGroupRatio = sortedGroups.stream().mapToDouble(entry -> entry.getValue().getRatio()).sum();
        double groupRandomValue = (secondHash % 100) / 100.0 * totalGroupRatio;

        double cumulativeRatio = 0;
        String selectedGroup = "未知组";
        String selectedParam = null;

        for (Map.Entry<String, GroupParams> entry : groupParams.entrySet()) {
            cumulativeRatio += entry.getValue().getRatio();
            if (groupRandomValue <= cumulativeRatio) {
                selectedGroup = entry.getKey();
                selectedParam = entry.getValue().getParam();
                break;
            }
        }

        return new UserGroupResult(userId, selectedExperiment, selectedGroup, selectedParam);
    }

    // 简单的 SHA-256 哈希函数
    private int hash(String input) throws NoSuchAlgorithmException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(input.getBytes());

        // 使用前 8 个字节生成一个长整数（Long）
        long hashValue = ((long) (hash[0] & 0xFF) << 56) |
                ((long) (hash[1] & 0xFF) << 48) |
                ((long) (hash[2] & 0xFF) << 40) |
                ((long) (hash[3] & 0xFF) << 32) |
                ((long) (hash[4] & 0xFF) << 24) |
                ((long) (hash[5] & 0xFF) << 16) |
                ((long) (hash[6] & 0xFF) << 8) |
                (hash[7] & 0xFF);

        // 映射到 0-99 范围
        return (int) Math.abs(hashValue % 100);
    }

    // 获取所有可用的桶号
    private List<Integer> getAvailableBuckets(Set<Integer> usedBuckets) {
        return IntStream.rangeClosed(1, 100)
                .filter(i -> !usedBuckets.contains(i))
                .boxed()
                .collect(Collectors.toList());
    }

}

// 实验类
class Experiment {
    private final double ratio;
    private final Set<Integer> buckets;

    public Experiment(double ratio, Set<Integer> buckets) {
        this.ratio = ratio;
        this.buckets = buckets;
    }

    public Set<Integer> getBuckets() {
        return buckets;
    }
}

// 分组参数类
class GroupParams {
    private final double ratio;
    private final String param;

    public GroupParams(double ratio, String param) {
        this.ratio = ratio;
        this.param = param;
    }

    public double getRatio() {
        return ratio;
    }

    public String getParam() {
        return param;
    }
}

// 用户组结果类
class UserGroupResult {
    private final String userId;
    private final String selectedExperiment;
    private final String selectedGroup;
    private final String param;

    public UserGroupResult(String userId, String selectedExperiment, String selectedGroup, String param) {
        this.userId = userId;
        this.selectedExperiment = selectedExperiment;
        this.selectedGroup = selectedGroup;
        this.param = param;
    }

    public String getUserId() {
        return userId;
    }

    public String getSelectedExperiment() {
        return selectedExperiment;
    }

    public String getSelectedGroup() {
        return selectedGroup;
    }

    public String getParam() {
        return param;
    }
}

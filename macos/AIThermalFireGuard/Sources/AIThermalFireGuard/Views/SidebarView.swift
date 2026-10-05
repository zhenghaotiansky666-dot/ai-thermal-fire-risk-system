import SwiftUI

struct SidebarView: View {
    @EnvironmentObject private var store: ThermalMonitorStore

    var body: some View {
        List(AppSection.allCases, selection: $store.selectedSection) { section in
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(section.title)
                        .font(.system(size: 13, weight: .medium))
                    Text(section.subtitle)
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } icon: {
                Image(systemName: section.icon)
                    .foregroundStyle(store.selectedSection == section ? Color.blue : Color.secondary)
            }
            .tag(section)
            .padding(.vertical, 3)
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 13) {
                HStack(spacing: 11) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 11)
                            .fill(LinearGradient(colors: [.blue, .cyan], startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 40, height: 40)
                        Image(systemName: "flame.fill")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(.white)
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text("FireAegis")
                            .font(.system(size: 15, weight: .bold))
                        Text("AI THERMAL GUARD")
                            .font(.system(size: 7, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .tracking(1.2)
                    }
                }

                HStack(spacing: 8) {
                    Circle()
                        .fill(store.isConnected ? .green : .red)
                        .frame(width: 7, height: 7)
                        .shadow(color: (store.isConnected ? Color.green : Color.red).opacity(0.7), radius: 4)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.connectionState.title)
                            .font(.system(size: 10, weight: .semibold))
                        Text(store.source.title)
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.blue.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                .overlay {
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(.blue.opacity(0.12), lineWidth: 1)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 16)
            .padding(.bottom, 10)
            .background(.ultraThinMaterial)
        }
    }
}

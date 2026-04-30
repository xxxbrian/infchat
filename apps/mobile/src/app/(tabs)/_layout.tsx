import { NativeTabs } from 'expo-router/unstable-native-tabs';

export default function TabsLayout() {
  return (
    <NativeTabs
      backgroundColor="transparent"
      blurEffect="systemUltraThinMaterialDark"
      disableTransparentOnScrollEdge
      iconColor={{ default: '#64748b', selected: '#f8fafc' }}
      labelStyle={{
        default: { color: '#64748b', fontWeight: '600' },
        selected: { color: '#f8fafc', fontWeight: '700' },
      }}
      shadowColor="transparent"
      tintColor="#f8fafc"
    >
      <NativeTabs.Trigger name="index" contentStyle={{ backgroundColor: '#080b12' }}>
        <NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'message', selected: 'message.fill' }} md="chat" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="friends" contentStyle={{ backgroundColor: '#080b12' }}>
        <NativeTabs.Trigger.Label>Friends</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person.2', selected: 'person.2.fill' }}
          md="group"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" contentStyle={{ backgroundColor: '#080b12' }}>
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'gearshape', selected: 'gearshape.fill' }}
          md="settings"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

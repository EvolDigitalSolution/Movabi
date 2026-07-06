import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ONE_SIGNAL_APP_ID = '952c6d19-656c-4dab-90f3-6e253e2c9151'
const ONE_SIGNAL_API_KEY = Deno.env.get('ONE_SIGNAL_REST_API_KEY')

interface PushNotificationData {
  recipientUserId: string
  type: 'new_chat_message' | 'driver_accepted' | 'driver_arrived' | 'trip_started' | 'shopping_completed' | 'items_collected' | 'driver_en_route' | 'trip_completed' | 'customer_cancelled' | 'driver_cancelled' | 'extra_budget_requested' | 'extra_budget_approved' | 'receipt_uploaded' | 'payment_completed' | 'new_driver_request'
  jobId: string
  title?: string
  body?: string
  data?: Record<string, any>
}

serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    const data: PushNotificationData = await req.json()
    
    if (!data.recipientUserId || !data.type || !data.jobId) {
      return new Response('Missing required fields: recipientUserId, type, jobId', { status: 400 })
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Get recipient's OneSignal player/subscription ID
    const { data: deviceTokens, error: tokenError } = await supabase
      .from('device_push_tokens')
      .select('token')
      .eq('user_id', data.recipientUserId)
      .eq('provider', 'onesignal')
      .eq('enabled', true)

    if (tokenError) {
      console.error('Error fetching device tokens:', tokenError)
      return new Response('Failed to fetch device tokens', { status: 500 })
    }

    if (!deviceTokens || deviceTokens.length === 0) {
      console.log('No device tokens found for user:', data.recipientUserId)
      return new Response('No device tokens found', { status: 404 })
    }

    // Get notification title and body
    const title = data.title || getNotificationTitle(data.type)
    const body = data.body || getNotificationBody(data.type)

    // Determine deep link based on notification type
    let openRoute = 'booking_tracking'
    if (data.type === 'new_chat_message') {
      openRoute = 'booking_chat'
    } else if (data.type === 'new_driver_request') {
      openRoute = 'driver_marketplace'
    }
    
    // Determine user role (you might need to fetch this from user profile or job data)
    const role = await getUserRole(supabase, data.recipientUserId, data.jobId)

    // Prepare notification payload
    const notificationPayload = {
      app_id: ONE_SIGNAL_APP_ID,
      include_player_ids: deviceTokens.map(token => token.token),
      headings: { en: title },
      contents: { en: body },
      data: {
        job_id: data.jobId,
        type: data.type,
        open: openRoute,
        role: role,
        ...data.data
      },
      android_channel_id: 'movabi_notifications',
      ios_sound: 'notification.wav',
      android_sound: 'notification',
      priority: 10,
      content_available: true
    }

    // Send push notification via OneSignal API
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${ONE_SIGNAL_API_KEY}`
      },
      body: JSON.stringify(notificationPayload)
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('OneSignal API error:', errorText)
      return new Response('Failed to send push notification', { status: 500 })
    }

    const result = await response.json()
    console.log('Push notification sent successfully:', result)

    return new Response(JSON.stringify({ success: true, result }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200
    })

  } catch (error) {
    console.error('Error in send-push-notification function:', error)
    return new Response('Internal server error', { status: 500 })
  }
})

function getNotificationTitle(type: string): string {
  const titles: Record<string, string> = {
    'new_chat_message': 'New message',
    'driver_accepted': 'Driver accepted your booking',
    'driver_arrived': 'Driver has arrived',
    'trip_started': 'Trip started',
    'shopping_completed': 'Shopping completed',
    'items_collected': 'Items collected',
    'driver_en_route': 'Driver is on the way',
    'trip_completed': 'Booking completed',
    'customer_cancelled': 'Booking cancelled',
    'driver_cancelled': 'Driver cancelled',
    'extra_budget_requested': 'Extra budget requested',
    'extra_budget_approved': 'Extra budget approved',
    'receipt_uploaded': 'Receipt uploaded',
    'payment_completed': 'Payment completed',
    'new_driver_request': 'New booking request'
  }

  return titles[type] || 'Update'
}

function getNotificationBody(type: string): string {
  const bodies: Record<string, string> = {
    'new_chat_message': 'You have a new message',
    'driver_accepted': 'A driver has accepted your booking',
    'driver_arrived': 'Your driver has arrived at the pickup location',
    'trip_started': 'Your trip has started',
    'shopping_completed': 'Shopping has been completed',
    'items_collected': 'Items have been collected',
    'driver_en_route': 'Your driver is on the way',
    'trip_completed': 'Your booking has been completed',
    'customer_cancelled': 'Booking was cancelled',
    'driver_cancelled': 'Driver cancelled the booking',
    'extra_budget_requested': 'Extra budget has been requested',
    'extra_budget_approved': 'Extra budget has been approved',
    'receipt_uploaded': 'Receipt has been uploaded',
    'payment_completed': 'Payment has been completed',
    'new_driver_request': 'A new booking request is available'
  }

  return bodies[type] || 'Update'
}

async function getUserRole(supabase: any, userId: string, jobId: string): Promise<'driver' | 'customer'> {
  try {
    // Check if user is the driver for this job
    const { data: booking } = await supabase
      .from('bookings')
      .select('driver_id, customer_id')
      .eq('id', jobId)
      .single()

    if (booking) {
      if (booking.driver_id === userId) return 'driver'
      if (booking.customer_id === userId) return 'customer'
    }

    // Fallback: check user profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single()

    return profile?.role === 'driver' ? 'driver' : 'customer'
  } catch (error) {
    console.error('Error determining user role:', error)
    return 'customer' // Default fallback
  }
}

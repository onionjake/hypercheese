HyperCheese::Application.routes.draw do
  devise_controllers = {
    sessions: 'user/sessions',
    passwords: 'user/passwords',
    registrations: 'user/registrations',
  }

  if Rails.application.config.use_omniauth
    devise_controllers[:omniauth_callbacks] = 'user/omniauth_callbacks'
  end

  devise_for :users, controllers: devise_controllers

  devise_scope :user do
    get "/users/pending", to: "user/registrations#pending"
    get "/users/choose", to: "user/sessions#choose"
  end


  # The priority is based upon order of creation:
  # first created -> highest priority.

  # Sample of regular route:
  #   match 'products/:id' => 'catalog#view'
  # Keep in mind you can assign values other than :controller and :action

  # Sample of named route:
  #   match 'products/:id/purchase' => 'catalog#purchase', :as => :purchase
  # This route can be invoked with purchase_url(:id => product.id)

  # Sample resource route (maps HTTP verbs to controller actions automatically):
  #   resources :products
  #
  resources :items do
    collection do
      post :add_tags
      post :remove_tag
      get :download
    end
    get :details
    post :toggle_star
  end

  resources :comments

  resources :tags

  resources :shares do
    get :download
  end

  # Sample resource route with options:
  #   resources :products do
  #     member do
  #       get 'short'
  #       post 'toggle'
  #     end
  #
  #     collection do
  #       get 'sold'
  #     end
  #   end

  # Sample resource route with sub-resources:
  #   resources :products do
  #     resources :comments, :sales
  #     resource :seller
  #   end

  # Sample resource route with more complex sub-resources
  #   resources :products do
  #     resources :comments
  #     resources :sales do
  #       get 'recent', :on => :collection
  #     end
  #   end

  # Sample resource route within a namespace:
  #   namespace :admin do
  #     # Directs /admin/products/* to Admin::ProductsController
  #     # (app/controllers/admin/products_controller.rb)
  #     resources :products
  #   end

  # You can have the root of your site routed with "root"
  # just remember to delete public/index.html.
  # root :to => 'welcome#index'
  root to: 'home#index'
  get 'activity', to: 'home#activity'

  # See how all your routes lay out with "rake routes"

  # This is a legacy wild controller route that's not recommended for RESTful applications.
  # Note: This route will make all actions in every controller accessible via GET requests.
  # match ':controller(/:action(/:id))(.:format)'
end
